// dsh-plugin-manager · core logic (pure Node, no cordis dependency).
//
// Two jobs:
//  1. enable/disable plugin rows by writing `{id, disabled}` override
//     entries into the profile's user patch layer (cordis.patch.yml),
//     which dsh web hot-reloads through its HMR watcher — the same
//     mechanism the launchers use for the telemetry switch.
//  2. audit plugin downloads: watch profile package.json / pnpm-lock.yaml
//     for changes and append one JSONL entry per install/update/remove,
//     recording the source (repository, registry, tarball) and the
//     installed-at time.
//
// The bundle patches are parsed without executing anything: `!!js`
// expressions are neutralized to `!!str` strings before parsing, so the
// composed row list is descriptive only — this module never evaluates a
// patch expression.

import { createRequire } from 'node:module'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { spawn } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

// ---------------------------------------------------------------------------
// paths

export function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
}

export function dataDir() {
  if (process.env.DPM_DATA_DIR && process.env.DPM_DATA_DIR !== '') return process.env.DPM_DATA_DIR
  return join(dshHome(), 'plugin-manager')
}

export function auditFile() {
  return join(dataDir(), 'audit.jsonl')
}

export function stateFile() {
  return join(dataDir(), 'state.json')
}

/**
 * Locate the dsh profile directory this plugin lives in: walk up from the
 * module's own location until a directory whose package.json declares
 * `dsh.profile.bundles` (the profile manifest), falling back to the
 * pnpm-workspace.yaml + cordis.yml marker pair.
 */
export function findProfileRoot(moduleUrl) {
  let dir = dirname(fileURLToPath(moduleUrl))
  for (;;) {
    const manifestPath = join(dir, 'package.json')
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
        if (manifest && typeof manifest === 'object' && Array.isArray(manifest.dsh?.profile?.bundles)) return dir
      } catch {
        // not a profile manifest; keep walking
      }
    }
    if (existsSync(join(dir, 'pnpm-workspace.yaml')) && existsSync(join(dir, 'cordis.yml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) throw new Error('cannot locate the dsh profile directory')
    dir = parent
  }
}

export function profileNameOf(profileDir) {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    const name = typeof manifest.name === 'string' ? manifest.name : ''
    if (name.startsWith('dsh-profile-')) return name.slice('dsh-profile-'.length)
  } catch {
    // fall through to dirname
  }
  return basename(profileDir)
}

export function readProfileManifest(profileDir) {
  const path = join(profileDir, 'package.json')
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`profile manifest ${path} must hold a JSON object`)
  }
  return parsed
}

/**
 * Resolution anchors for bundle packages, installation-first (mirrors
 * resolveBundleDir in @deepseek-ai/dsh-app-boot): the running dsh install,
 * the boot library, then the profile itself.
 */
export function anchorsFor(profileDir) {
  const anchors = []
  const argv1 = process.argv[1]
  if (typeof argv1 === 'string' && argv1 !== '') {
    const pkg = dirname(dirname(argv1))
    if (existsSync(join(pkg, 'package.json'))) anchors.push(join(pkg, 'package.json'))
  }
  try {
    const req = createRequire(join(profileDir, 'package.json'))
    anchors.push(req.resolve('@deepseek-ai/dsh-app-boot/package.json'))
  } catch {
    // boot lib not resolvable from the profile; the argv anchor may suffice
  }
  anchors.push(join(profileDir, 'package.json'))
  return anchors
}

export function resolveBundleDir(anchors, packageName) {
  for (const anchor of anchors) {
    try {
      for (const searchPath of createRequire(anchor).resolve.paths(packageName) ?? []) {
        const candidate = join(searchPath, packageName)
        if (existsSync(join(candidate, 'package.json'))) return candidate
      }
    } catch {
      // next anchor
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// patch parsing / composition

/**
 * Parse a patch-list file (top-level YAML array). `!!js` expressions are
 * neutralized to `!!str` so the file parses without executing anything; the
 * string value is opaque to this module (never evaluated).
 */
export function parsePatchList(text, file) {
  if (typeof text !== 'string' || text.trim() === '') return []
  const prepared = text
    .replace(/(:\s+)!!js(?=\s|$)/g, '$1!!str')
    .replace(/(^\s*-\s+)!!js(?=\s|$)/gm, '$1!!str')
  const parsed = YAML.parse(prepared, { prettyErrors: true })
  if (!Array.isArray(parsed)) throw new Error(`${file}: patch list must be a YAML array`)
  return parsed
}

/**
 * Mirror of the boot include's applyEntryPatches: id-targeted overrides and
 * insert lists, last write wins per row id. Never mutates the input.
 * @param onInserted - called with every inserted entry (for attribution).
 */
export function applyPatches(data, patches, onInserted) {
  data = structuredClone(data)
  const entryMap = new Map()
  const buildMap = (entries) => {
    for (const entry of entries) {
      if (entry && typeof entry === 'object') {
        if (entry.id) entryMap.set(entry.id, entry)
        if (entry.group && Array.isArray(entry.config)) buildMap(entry.config)
      }
    }
  }
  buildMap(data)
  for (const patch of patches) {
    if (!patch || typeof patch !== 'object') continue
    const { id, insert, name, ...overrides } = patch
    if (insert) {
      const list = Array.isArray(insert) ? insert : [insert]
      if (id) {
        const target = entryMap.get(id)
        if (target && target.group) {
          if (!Array.isArray(target.config)) target.config = []
          target.config.push(...list)
        }
      } else {
        data.push(...list)
      }
      if (onInserted) for (const entry of list) onInserted(entry)
      buildMap(list)
      continue
    }
    if (!id) continue
    const target = entryMap.get(id)
    if (!target) continue
    if (name && name !== target.name) continue
    for (const [key, value] of Object.entries(overrides)) {
      if (key === 'id') continue
      target[key] = value
    }
  }
  return data
}

const CORE_BUNDLES = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])

export function isProtected(rowId, name, sourceBundle, fromUserLayer) {
  if (rowId === 'plugin-manager' || name === 'dsh-plugin-manager') return true
  if (sourceBundle !== null && CORE_BUNDLES.has(sourceBundle)) return true
  // rows with no bundle provenance (group children, plugin-internal entries)
  // are treated as core: conservative, never accidentally toggleable.
  if (sourceBundle === null && !fromUserLayer) return true
  return false
}

/**
 * Compose the profile's full row tree: bundle patches in bundles order, then
 * the profile's user patch layer. Returns the flat composed entry list plus
 * per-row attribution (which bundle inserted the row).
 */
export function compose(profileDir, anchors) {
  const manifest = readProfileManifest(profileDir)
  const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
  let data = []
  const seen = new Map()
  const rows = []
  const register = (entry, sourceBundle, fromUserLayer) => {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') return
    let row = seen.get(entry.id)
    if (!row) {
      row = { entry, id: entry.id, name: entry.name ?? null, sourceBundle: null, fromUserLayer: false }
      seen.set(entry.id, row)
      rows.push(row)
    }
    if (sourceBundle && !row.sourceBundle) row.sourceBundle = sourceBundle
    if (fromUserLayer) row.fromUserLayer = true
  }
  for (const bundle of bundles) {
    const bundleDir = resolveBundleDir(anchors, bundle)
    let patches = []
    if (bundleDir) {
      const patchFile = join(bundleDir, 'cordis.patch.yml')
      if (existsSync(patchFile)) {
        try {
          patches = parsePatchList(readFileSync(patchFile, 'utf8'), patchFile)
        } catch (error) {
          rows.push({
            id: `bundle:${bundle}`,
            entry: null,
            name: bundle,
            sourceBundle: bundle,
            fromUserLayer: false,
            opaque: true,
            error: String(error?.message ?? error),
          })
        }
      }
    } else {
      rows.push({
        id: `bundle:${bundle}`,
        entry: null,
        name: bundle,
        sourceBundle: bundle,
        fromUserLayer: false,
        opaque: true,
        error: 'bundle package not found',
      })
    }
    data = applyPatches(data, patches, (entry) => register(entry, bundle, false))
  }
  const userFile = join(profileDir, 'cordis.patch.yml')
  const userPatches = existsSync(userFile) ? parsePatchList(readFileSync(userFile, 'utf8'), userFile) : []
  data = applyPatches(data, userPatches, (entry) => register(entry, null, true))
  const flat = []
  const walk = (entries) => {
    for (const entry of entries) {
      flat.push(entry)
      if (entry && entry.group && Array.isArray(entry.config)) walk(entry.config)
    }
  }
  walk(data)
  return { manifest, bundles, data, flat, rows, seen, userFile, userPatches }
}

// ---------------------------------------------------------------------------
// package metadata

export function packageDir(profileDir, name) {
  const parts = name.startsWith('@') ? name.split('/') : [name]
  const dir = join(profileDir, 'node_modules', ...parts)
  return existsSync(join(dir, 'package.json')) ? dir : null
}

export function packageInfo(profileDir, name) {
  const dir = packageDir(profileDir, name)
  if (!dir) return null
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    let stat
    try {
      stat = statSync(dir)
    } catch {
      return null
    }
    let repository = null
    const repo = manifest.repository
    if (typeof repo === 'string') repository = repo
    else if (repo && typeof repo.url === 'string') repository = repo.url
    const dsh = manifest.dsh
    const kind = dsh?.bundle ? (dsh?.client ? 'mixed' : 'server') : dsh?.client ? 'client' : 'dependency'
    return {
      version: manifest.version ?? null,
      description: manifest.description ?? null,
      repository,
      homepage: manifest.homepage ?? null,
      installedAt: stat.mtime.toISOString(),
      kind,
    }
  } catch {
    return null
  }
}

export function registryOf(profileDir) {
  try {
    const text = readFileSync(join(profileDir, '.npmrc'), 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*registry\s*=\s*(.+?)\s*$/.exec(line)
      if (match && !match[1].startsWith('#')) return match[1]
    }
  } catch {
    // no .npmrc
  }
  return null
}

/** name → {version, tarball} from pnpm-lock.yaml packages. */
export function readLock(profileDir) {
  const map = new Map()
  const file = join(profileDir, 'pnpm-lock.yaml')
  if (!existsSync(file)) return map
  try {
    const doc = YAML.parse(readFileSync(file, 'utf8'))
    const packages = doc?.packages
    if (packages && typeof packages === 'object') {
      for (const [key, value] of Object.entries(packages)) {
        if (typeof key !== 'string') continue
        const at = key.lastIndexOf('@')
        if (at <= 0) continue
        const name = key.slice(0, at)
        const version = key.slice(at + 1)
        const tarball = value?.resolution?.tarball ?? null
        const entry = map.get(name)
        if (!entry) map.set(name, { version, tarball })
        else if (!entry.tarball && tarball) entry.tarball = tarball
      }
    }
  } catch {
    // unreadable lockfile: sources degrade to repository fields only
  }
  return map
}

// ---------------------------------------------------------------------------
// plugin listing

export function listPlugins(profileDir, anchors) {
  const { flat, seen } = compose(profileDir, anchors)
  const registry = registryOf(profileDir)
  const lock = readLock(profileDir)
  const out = []
  for (const entry of flat) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') continue
    const meta = seen.get(entry.id)
    const name = entry.name ?? meta?.name ?? null
    const sourceBundle = meta?.sourceBundle ?? null
    const fromUserLayer = meta?.fromUserLayer ?? false
    const info = name ? packageInfo(profileDir, name) : null
    const lockInfo = name ? lock.get(name) : undefined
    out.push({
      rowId: entry.id,
      name,
      sourceBundle,
      fromUserLayer,
      group: entry.group === true,
      disabled: entry.disabled === true,
      enabled: entry.disabled !== true,
      protected: isProtected(entry.id, name, sourceBundle, fromUserLayer),
      description: info?.description ?? null,
      version: info?.version ?? null,
      repository: info?.repository ?? null,
      homepage: info?.homepage ?? null,
      installedAt: info?.installedAt ?? null,
      kind: entry.group === true ? 'group' : info?.kind ?? 'unknown',
      registry,
      tarball: lockInfo?.tarball ?? null,
      opaque: meta?.opaque === true,
      error: meta?.error ?? null,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// enable / disable

/**
 * Write `{id: rowId, disabled: true}` into the profile's cordis.patch.yml
 * (or remove it again when re-enabling). Comments and unrelated entries are
 * preserved through the yaml document API; `!!js` expressions in an existing
 * user file make it unmanageable and are refused.
 */
export function updatePatchFile(file, rowId, enabled) {
  if (enabled && !existsSync(file)) return { ok: true }
  let text = ''
  if (existsSync(file)) {
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      return { ok: false, error: `cannot read ${file}: ${error?.message ?? error}` }
    }
  }
  if (/\b!!js\b/.test(text)) {
    return { ok: false, error: `${file} contains !!js expressions; the plugin manager refuses to rewrite it` }
  }
  let doc
  try {
    doc = YAML.parseDocument(text, { prettyErrors: true })
    if (doc.errors.length > 0) throw new Error(doc.errors[0].message)
  } catch (error) {
    return { ok: false, error: `cannot parse ${file}: ${error?.message ?? error}` }
  }
  let seq = doc.contents
  if (seq === null || seq === undefined) {
    seq = doc.createNode([], { flow: false })
    seq.commentBefore =
      ' Managed by the dsh-plugin-manager plugin: one `disabled` override per\n' +
      ' plugin row. dsh web hot-reloads this file; manual edits are welcome.'
    doc.contents = seq
  }
  if (!YAML.isSeq(seq)) {
    return { ok: false, error: `${file} must hold a YAML list of patch entries` }
  }
  const targets = []
  for (const item of seq.items) {
    if (!YAML.isMap(item)) continue
    if (item.has('insert')) continue
    if (item.get('id') === rowId) targets.push(item)
  }
  if (enabled) {
    for (const item of targets) {
      const index = seq.items.indexOf(item)
      if (index >= 0) seq.delete(index)
    }
  } else {
    let target = targets[0]
    if (!target) {
      target = doc.createNode({ id: rowId, disabled: true })
      seq.add(target)
    } else {
      target.set('disabled', true)
      for (const extra of targets.slice(1)) {
        const index = seq.items.indexOf(extra)
        if (index >= 0) seq.delete(index)
      }
    }
  }
  let output
  try {
    output = doc.toString({ indent: 2, lineWidth: 0 })
  } catch (error) {
    return { ok: false, error: `cannot serialize ${file}: ${error?.message ?? error}` }
  }
  try {
    writeAtomic(file, output)
  } catch (error) {
    return { ok: false, error: `cannot write ${file}: ${error?.message ?? error}` }
  }
  return { ok: true }
}

export function setPluginEnabled(profileDir, anchors, rowId, enabled) {
  const { flat, seen } = compose(profileDir, anchors)
  const entry = flat.find((candidate) => candidate && candidate.id === rowId) ?? null
  if (!entry) return { ok: false, error: `row "${rowId}" does not exist in the composed plugin tree` }
  const meta = seen.get(rowId)
  const name = entry.name ?? meta?.name ?? null
  const sourceBundle = meta?.sourceBundle ?? null
  const fromUserLayer = meta?.fromUserLayer ?? false
  if (isProtected(rowId, name, sourceBundle, fromUserLayer)) {
    return { ok: false, error: `row "${rowId}" is a core row and cannot be toggled` }
  }
  const file = join(profileDir, 'cordis.patch.yml')
  const result = updatePatchFile(file, rowId, enabled)
  if (!result.ok) return result
  return {
    ok: true,
    rowId,
    enabled,
    name,
    patchFile: file,
    note: 'patch written; dsh web hot-reloads it (restart dsh web if the change does not apply)',
  }
}

// ---------------------------------------------------------------------------
// audit

export function watchSignature(profileDir) {
  let sig = ''
  for (const file of ['package.json', 'pnpm-lock.yaml', '.npmrc']) {
    try {
      const stat = statSync(join(profileDir, file))
      sig += `${file}:${stat.mtimeMs}:${stat.size};`
    } catch {
      sig += `${file}:-;`
    }
  }
  return sig
}

function readPluginManifest(dir) {
  const file = join(dir, 'package.json')
  if (!existsSync(file)) return null
  try {
    const manifest = JSON.parse(readFileSync(file, 'utf8'))
    if (!manifest.dsh) return null
    let stat
    try {
      stat = statSync(dir)
    } catch {
      return null
    }
    let repository = null
    const repo = manifest.repository
    if (typeof repo === 'string') repository = repo
    else if (repo && typeof repo.url === 'string') repository = repo.url
    return {
      version: manifest.version ?? null,
      repository,
      homepage: manifest.homepage ?? null,
      installedAt: stat.mtime.toISOString(),
      kind: manifest.dsh.bundle ? (manifest.dsh.client ? 'mixed' : 'server') : 'client',
    }
  } catch {
    return null
  }
}

/** Every installed package that declares a `dsh` field (plugin-ish). */
export function installedPlugins(profileDir) {
  const out = new Map()
  const root = join(profileDir, 'node_modules')
  let entries = []
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    if (entry.name.startsWith('@')) {
      const scoped = join(root, entry.name)
      let subs = []
      try {
        subs = readdirSync(scoped, { withFileTypes: true })
      } catch {
        continue
      }
      for (const sub of subs) {
        if (!sub.isDirectory()) continue
        const info = readPluginManifest(join(scoped, sub.name))
        if (info) out.set(`${entry.name}/${sub.name}`, info)
      }
      continue
    }
    const info = readPluginManifest(join(root, entry.name))
    if (info) out.set(entry.name, info)
  }
  return out
}

/**
 * Diff the current plugin set against the persisted state and append one
 * audit line per change. First run records every current plugin as
 * `baseline`. Safe to call repeatedly.
 */
export function scanNow(profileDir, anchors, profileName) {
  const now = new Date().toISOString()
  const current = installedPlugins(profileDir)
  const registry = registryOf(profileDir)
  const lock = readLock(profileDir)
  const dir = dataDir()
  mkdirSync(dir, { recursive: true })
  const statePath = stateFile()
  const auditPath = auditFile()
  let prev = {}
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) prev = parsed
  } catch {
    prev = {}
  }
  const firstRun = Object.keys(prev).length === 0
  const events = []
  for (const [name, info] of current) {
    const prior = prev[name]
    const lockInfo = lock.get(name)
    let event = null
    if (!prior) event = firstRun ? 'baseline' : 'installed'
    else if (prior.version !== info.version) event = 'updated'
    if (!event) continue
    events.push({
      t: now,
      profile: profileName,
      event,
      name,
      version: info.version,
      repository: info.repository,
      homepage: info.homepage,
      registry,
      tarball: lockInfo?.tarball ?? null,
      installedAt: info.installedAt,
      detected: firstRun ? 'startup' : 'watch',
      kind: info.kind,
    })
  }
  for (const name of Object.keys(prev)) {
    if (current.has(name)) continue
    const prior = prev[name]
    events.push({
      t: now,
      profile: profileName,
      event: 'removed',
      name,
      version: prior.version ?? null,
      repository: prior.repository ?? null,
      homepage: prior.homepage ?? null,
      registry,
      tarball: null,
      installedAt: prior.installedAt ?? null,
      detected: firstRun ? 'startup' : 'watch',
      kind: prior.kind ?? null,
    })
  }
  const nextState = {}
  for (const [name, info] of current) nextState[name] = info
  try {
    writeFileSync(statePath, JSON.stringify(nextState, null, 2) + '\n')
  } catch (error) {
    throw new Error(`cannot persist audit state: ${error?.message ?? error}`)
  }
  if (events.length > 0) {
    const lines = events.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
    try {
      appendFileSync(auditPath, lines)
    } catch (error) {
      throw new Error(`cannot append audit log: ${error?.message ?? error}`)
    }
  }
  return events
}

export function loadAudit(limit = 300) {
  const file = auditFile()
  if (!existsSync(file)) return []
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '')
  const entries = []
  for (const line of lines.slice(-limit)) {
    try {
      entries.push(JSON.parse(line))
    } catch {
      // skip a corrupt line
    }
  }
  return entries.reverse()
}

// ---------------------------------------------------------------------------
// uninstall

/** npm package-name shape (unscoped or scoped), the only form we ever pass to a shell. */
const PACKAGE_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

/** Whether the installed package declares a profile patch (`dsh.bundle`). */
export function exportsPatch(packageName, profileDir) {
  const dir = packageDir(profileDir, packageName)
  if (!dir) return false
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return manifest.dsh?.bundle?.patch !== undefined
  } catch {
    return false
  }
}

/**
 * Reconcile `dsh.profile.bundles` against the installed state after a pnpm
 * remove — the same logic `dsh plugin` applies: a bundle entry that was a
 * dependency but is no longer (removed, or the installed version dropped the
 * declaration) leaves the layer stack; in-box bundles are never touched.
 */
export function reconcileBundles(profileDir, beforeDeps) {
  const after = readProfileManifest(profileDir)
  const dependencies = Object.keys(after.dependencies ?? {})
  const plugins = Array.isArray(after.dsh?.profile?.bundles) ? after.dsh.profile.bundles : []
  const beforeDepsSet = new Set(beforeDeps)
  const dependencySet = new Set(dependencies)
  let changed = false
  for (const packageName of [...plugins]) {
    const wasDependency = beforeDepsSet.has(packageName) || dependencySet.has(packageName)
    const stillBundle = dependencySet.has(packageName) && exportsPatch(packageName, profileDir)
    if (wasDependency && !stillBundle) {
      plugins.splice(plugins.indexOf(packageName), 1)
      changed = true
    }
  }
  if (!changed) return
  after.dsh = {
    ...after.dsh,
    profile: {
      ...after.dsh?.profile,
      bundles: plugins,
    },
  }
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify(after, null, 2) + '\n')
}

/**
 * Profile dependencies that are plugin packages (declare a `dsh` field or
 * sit in the bundle layer), each with the rows it contributes — the
 * uninstall candidate list. Plain libraries (e.g. `yaml`) never appear.
 */
export function listPackages(profileDir, anchors) {
  const { manifest, flat, seen } = compose(profileDir, anchors)
  const deps = Object.keys(manifest.dependencies ?? {})
  const registry = registryOf(profileDir)
  const lock = readLock(profileDir)
  const out = []
  for (const packageName of deps) {
    const info = packageInfo(profileDir, packageName)
    if (!info || info.kind === 'dependency') continue
    const rows = []
    for (const entry of flat) {
      if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') continue
      const meta = seen.get(entry.id)
      if (entry.name === packageName || meta?.sourceBundle === packageName) rows.push(entry.id)
    }
    out.push({
      name: packageName,
      version: info.version,
      description: info.description,
      repository: info.repository,
      homepage: info.homepage,
      installedAt: info.installedAt,
      kind: info.kind,
      rows,
      registry,
      tarball: lock.get(packageName)?.tarball ?? null,
      uninstallable: !CORE_BUNDLES.has(packageName),
    })
  }
  return out
}

function runPnpmRemove(profileDir, packageName, timeoutMs = 240_000) {
  return new Promise((resolve) => {
    // win32: spawn cmd.exe with one command string (packageName is validated
    // by PACKAGE_NAME_RE, so no injection surface) — avoids Node 24's
    // shell-args deprecation warning while keeping pnpm.cmd resolution.
    const isWin = process.platform === 'win32'
    const child = isWin
      ? spawn('cmd.exe', ['/d', '/s', '/c', `pnpm remove ${packageName}`], { cwd: profileDir, windowsHide: true })
      : spawn('pnpm', ['remove', packageName], { cwd: profileDir, windowsHide: true })
    let out = ''
    let err = ''
    const outBox = { value: out }
    const errBox = { value: err }
    child.stdout?.on('data', (chunk) => {
      outBox.value += chunk
      if (outBox.value.length > 8000) outBox.value = outBox.value.slice(-8000)
    })
    child.stderr?.on('data', (chunk) => {
      errBox.value += chunk
      if (errBox.value.length > 8000) errBox.value = errBox.value.slice(-8000)
    })
    const timer = setTimeout(() => {
      child.kill()
      resolve({ ok: false, error: 'timeout', code: null, out: outBox.value, err: errBox.value })
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({
        ok: false,
        error: error?.code === 'ENOENT' ? 'pnpm-not-found' : String(error?.message ?? error),
        code: null,
        out: outBox.value,
        err: errBox.value,
      })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, code, out: outBox.value, err: errBox.value })
    })
  })
}

/**
 * Uninstall one plugin package from the profile:
 *  1. refuse non-dependency / core / plain-library targets;
 *  2. drop the manager's disable entries for every affected row;
 *  3. run `pnpm remove` in the profile (the canonical path, same as
 *     `dsh plugin remove`) and reconcile the bundle layer; if pnpm is
 *     unavailable or fails, fall back to manual removal (dependencies +
 *     bundles + node_modules directory; the lockfile is left for pnpm to
 *     repair on its next run);
 *  4. record the removal in the audit log.
 * @param options - `{ runner: 'pnpm' | 'manual' }` (default pnpm).
 */
export async function uninstallPackage(profileDir, anchors, profileName, packageName, options = {}) {
  if (typeof packageName !== 'string' || !PACKAGE_NAME_RE.test(packageName)) {
    return { ok: false, error: 'invalid package name' }
  }
  const manifest = readProfileManifest(profileDir)
  const beforeDeps = Object.keys(manifest.dependencies ?? {})
  if (!beforeDeps.includes(packageName)) {
    return { ok: false, error: `"${packageName}" is not a dependency of this profile` }
  }
  if (CORE_BUNDLES.has(packageName)) {
    return { ok: false, error: `"${packageName}" is a core bundle and cannot be uninstalled` }
  }
  const info = packageInfo(profileDir, packageName)
  if (!info || info.kind === 'dependency') {
    return { ok: false, error: `"${packageName}" is not a plugin package` }
  }

  // 1. rows this package contributes, and its disable-entry cleanup
  const { flat, seen } = compose(profileDir, anchors)
  const affectedRows = []
  for (const entry of flat) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') continue
    const meta = seen.get(entry.id)
    if (entry.name === packageName || meta?.sourceBundle === packageName) affectedRows.push(entry.id)
  }
  const patchFile = join(profileDir, 'cordis.patch.yml')
  let cleanupError = null
  for (const rowId of [...new Set(affectedRows)]) {
    const result = updatePatchFile(patchFile, rowId, true)
    if (!result.ok) cleanupError = cleanupError ?? result.error
  }

  // 2. remove the package
  let via = 'manual'
  let pnpm = null
  if (options.runner !== 'manual') {
    pnpm = await runPnpmRemove(profileDir, packageName)
    if (pnpm.ok) {
      via = 'pnpm'
      reconcileBundles(profileDir, beforeDeps)
    }
  }
  if (via === 'manual') {
    const after = readProfileManifest(profileDir)
    const deps = after.dependencies ?? {}
    if (packageName in deps) delete deps[packageName]
    const plugins = Array.isArray(after.dsh?.profile?.bundles) ? after.dsh.profile.bundles : []
    const index = plugins.indexOf(packageName)
    if (index >= 0) plugins.splice(index, 1)
    after.dependencies = deps
    after.dsh = {
      ...after.dsh,
      profile: {
        ...after.dsh?.profile,
        bundles: plugins,
      },
    }
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify(after, null, 2) + '\n')
    const dir = packageDir(profileDir, packageName)
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch (error) {
        cleanupError = cleanupError ?? `cannot remove ${dir}: ${error?.message ?? error}`
      }
    }
  }

  // 3. audit the removal (pnpm may also have pruned orphaned sub-packages)
  let auditEvents = []
  try {
    auditEvents = scanNow(profileDir, anchors, profileName)
  } catch (error) {
    cleanupError = cleanupError ?? `audit scan failed: ${error?.message ?? error}`
  }

  return {
    ok: true,
    packageName,
    via,
    removedRows: [...new Set(affectedRows)],
    cleanupError,
    pnpmError: pnpm && !pnpm.ok ? pnpm.error ?? `pnpm exit ${pnpm.code}` : null,
    pnpmOutput: pnpm && pnpm.ok ? (pnpm.err || pnpm.out || '').trim().slice(-2000) : null,
    auditEvents,
    note: 'package and its rows are removed; the running dsh web keeps the old code until restarted',
  }
}

// ---------------------------------------------------------------------------
// helpers

function writeAtomic(file, content) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, content, 'utf8')
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file)
      return
    } catch (error) {
      const code = error?.code
      if (attempt >= 9 || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES')) {
        try {
          writeFileSync(file, content, 'utf8')
        } finally {
          try {
            unlinkSync(tmp)
          } catch {
            // ignore
          }
        }
        return
      }
      // busy (HMR watcher may hold the file): brief synchronous backoff
      const sab = new SharedArrayBuffer(4)
      Atomics.wait(new Int32Array(sab), 0, 0, 50)
    }
  }
}
