// Smoke tests for dsh-plugin-manager core logic.
//  1. hermetic fixture: compose / toggle round-trip / protected rows / audit
//  2. real profile: read-only listing (no mutation)
//
// Run: node test/core.test.mjs  (from the package root)

import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as core from '../lib/core.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
let failures = 0

function ok(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`)
  } else {
    failures += 1
    console.error(`  ✗ FAIL: ${label}`)
  }
}

function makeFixture() {
  const dir = join(process.env.TEMP ?? '/tmp', `dpm-fixture-${process.pid}-${Date.now()}`)
  mkdirSync(join(dir, 'node_modules', 'plugin-a'), { recursive: true })
  mkdirSync(join(dir, 'node_modules', 'plugin-b'), { recursive: true })
  mkdirSync(join(dir, 'node_modules', 'plugin-aggregate'), { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'dsh-profile-fixture',
      private: true,
      dependencies: { 'plugin-a': '1.0.0', 'plugin-b': '2.0.0', 'plugin-aggregate': '3.0.0' },
      dsh: { profile: { bundles: ['plugin-a', 'plugin-b', 'plugin-aggregate'] } },
    }, null, 2) + '\n',
  )
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\n')
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  writeFileSync(join(dir, '.npmrc'), 'registry=https://registry.npmmirror.com\n')
  writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\npackages:\n  plugin-a@1.0.0:\n    resolution: {integrity: sha512-x}\n  plugin-b@2.0.0:\n    resolution: {integrity: sha512-y, tarball: https://registry.example.com/plugin-b.tgz}\n')
  const pkg = (name, manifest) => {
    writeFileSync(join(dir, 'node_modules', name, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  }
  pkg('plugin-a', {
    name: 'plugin-a', version: '1.0.0', description: 'Fixture A',
    repository: { type: 'git', url: 'https://github.com/fixture/plugin-a' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  writeFileSync(join(dir, 'node_modules', 'plugin-a', 'cordis.patch.yml'), '- insert:\n    - id: row-a\n      name: plugin-a\n')
  pkg('plugin-b', {
    name: 'plugin-b', version: '2.0.0', description: 'Fixture B',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  writeFileSync(join(dir, 'node_modules', 'plugin-b', 'cordis.patch.yml'), '- insert:\n    - id: row-b\n      name: plugin-b\n')
  pkg('plugin-aggregate', {
    name: 'plugin-aggregate', version: '3.0.0', description: 'Aggregate',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  writeFileSync(
    join(dir, 'node_modules', 'plugin-aggregate', 'cordis.patch.yml'),
    '- insert:\n    - id: row-b2\n      name: plugin-b\n    - id: row-aggregate\n      name: plugin-aggregate\n',
  )
  return dir
}

// ---------------------------------------------------------------------------

console.log('== fixture: compose + list ==')
{
  const dir = makeFixture()
  const anchors = [join(dir, 'package.json')]
  const plugins = core.listPlugins(dir, anchors)
  const ids = plugins.map((p) => p.rowId).sort()
  ok(ids.includes('row-a') && ids.includes('row-b') && ids.includes('row-b2') && ids.includes('row-aggregate'), `rows composed: ${ids.join(', ')}`)
  const rowA = plugins.find((p) => p.rowId === 'row-a')
  ok(rowA.enabled === true, 'row-a enabled by default')
  ok(rowA.sourceBundle === 'plugin-a', 'row-a attributed to plugin-a')
  ok(rowA.registry === 'https://registry.npmmirror.com', 'registry read from .npmrc')
  const rowB = plugins.find((p) => p.rowId === 'row-b')
  ok(rowB.tarball === 'https://registry.example.com/plugin-b.tgz', 'tarball read from lockfile')
  ok(rowB.installedAt !== null, 'installedAt from node_modules mtime')

  console.log('== fixture: toggle round-trip ==')
  const r1 = core.setPluginEnabled(dir, anchors, 'row-b', false)
  ok(r1.ok === true, 'disable row-b ok')
  const fileText = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
  ok(/id: row-b/.test(fileText) && /disabled: true/.test(fileText), `patch file written: ${fileText.trim().split('\n').join(' | ')}`)
  const after = core.listPlugins(dir, anchors)
  ok(after.find((p) => p.rowId === 'row-b').enabled === false, 'row-b now disabled')
  ok(after.find((p) => p.rowId === 'row-a').enabled === true, 'row-a untouched')
  const r2 = core.setPluginEnabled(dir, anchors, 'row-b', true)
  ok(r2.ok === true, 're-enable row-b ok')
  const fileText2 = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
  ok(!/row-b/.test(fileText2), 'disable entry removed after re-enable')

  console.log('== fixture: protected + unknown ==')
  const r3 = core.setPluginEnabled(dir, anchors, 'row-does-not-exist', false)
  ok(r3.ok === false && /does not exist/.test(r3.error), 'unknown row refused')
  writeFileSync(join(dir, 'node_modules', 'plugin-a', 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-base', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2) + '\n')
  writeFileSync(join(dir, 'node_modules', 'plugin-a', 'cordis.patch.yml'), '- insert:\n    - id: core-row\n      name: core-pkg\n')
  const corePlugins = core.listPlugins(dir, anchors)
  const coreRow = corePlugins.find((p) => p.rowId === 'core-row')
  // the bundle name is still plugin-a, so core-row is NOT protected here —
  // protected comes from sourceBundle being a core bundle; simulate by toggling
  // via a direct compose with a fake core bundle
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-fixture', private: true,
    dependencies: { 'plugin-a': '1.0.0', 'plugin-b': '2.0.0', 'plugin-aggregate': '3.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'plugin-b'] } },
  }, null, 2) + '\n')
  mkdirSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh-base'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-base', version: '9.9.9', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2) + '\n')
  writeFileSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh-base', 'cordis.patch.yml'), '- insert:\n    - id: core-row\n      name: core-pkg\n      config:\n        x: !!js process.platform\n')
  const withCore = core.listPlugins(dir, anchors)
  const coreRow2 = withCore.find((p) => p.rowId === 'core-row')
  ok(coreRow2 && coreRow2.protected === true, 'core-bundle row protected')
  ok(coreRow2 && coreRow2.name === 'core-pkg', '!!js neutralized (parse did not throw)')
  const r4 = core.setPluginEnabled(dir, anchors, 'core-row', false)
  ok(r4.ok === false && /core row/.test(r4.error), 'protected row toggle refused')

  console.log('== fixture: audit ==')
  process.env.DPM_DATA_DIR = join(dir, 'audit-data')
  const events1 = core.scanNow(dir, anchors, 'fixture')
  ok(events1.length === 4, `baseline records 4 plugins (got ${events1.length})`)
  ok(events1.every((e) => e.event === 'baseline'), 'first scan is baseline')
  ok(events1.every((e) => e.repository || e.registry), 'baseline carries source info')
  // simulate an install: add plugin-c
  mkdirSync(join(dir, 'node_modules', 'plugin-c'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'plugin-c', 'package.json'), JSON.stringify({
    name: 'plugin-c', version: '1.2.3', repository: 'https://github.com/fixture/plugin-c', dsh: { client: { platform: 'web' } },
  }, null, 2) + '\n')
  const events2 = core.scanNow(dir, anchors, 'fixture')
  ok(events2.length === 1 && events2[0].event === 'installed' && events2[0].name === 'plugin-c', 'new plugin detected as installed')
  ok(events2[0].repository === 'https://github.com/fixture/plugin-c', 'install records repository source')
  const audit = core.loadAudit(10)
  ok(audit.length === 5, `audit file has 5 entries (got ${audit.length})`)
  ok(audit[0].event === 'installed' && audit[0].name === 'plugin-c', 'audit newest-first')
  delete process.env.DPM_DATA_DIR
  rmSync(dir, { recursive: true, force: true })
}

console.log('== fixture: packages list + uninstall (manual runner) ==')
{
  const dir = makeFixture()
  const anchors = [join(dir, 'package.json')]
  // add a plain library dep: must never be listed as uninstallable
  mkdirSync(join(dir, 'node_modules', 'plain-lib'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'plain-lib', 'package.json'), JSON.stringify({
    name: 'plain-lib', version: '9.9.9',
  }, null, 2) + '\n')
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  manifest.dependencies['plain-lib'] = '9.9.9'
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')

  const packages = core.listPackages(dir, anchors)
  ok(packages.length === 3, `listPackages finds 3 plugin packages (got ${packages.length}: ${packages.map((p) => p.name).join(', ')})`)
  ok(!packages.some((p) => p.name === 'plain-lib'), 'plain library is not listed')
  const agg = packages.find((p) => p.name === 'plugin-aggregate')
  ok(agg && agg.rows.includes('row-b2') && agg.rows.includes('row-aggregate'), 'aggregate lists its contributed rows')
  ok(packages.every((p) => p.uninstallable === true), 'fixture packages are uninstallable')

  // guards
  const g1 = await core.uninstallPackage(dir, anchors, 'fixture', 'plain-lib', { runner: 'manual' })
  ok(g1.ok === false && /not a plugin package/.test(g1.error), 'plain library uninstall refused')
  const g2 = await core.uninstallPackage(dir, anchors, 'fixture', 'not-a-dep', { runner: 'manual' })
  ok(g2.ok === false && /not a dependency/.test(g2.error), 'non-dependency uninstall refused')

  // disable row-b first, then uninstall plugin-b: the disable entry must be cleaned up
  core.setPluginEnabled(dir, anchors, 'row-b', false)
  const before = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
  ok(/row-b/.test(before), 'row-b disabled before uninstall')

  process.env.DPM_DATA_DIR = join(dir, 'audit-data')
  core.scanNow(dir, anchors, 'fixture') // pre-seed state so the removal diffs as `removed`
  const result = await core.uninstallPackage(dir, anchors, 'fixture', 'plugin-b', { runner: 'manual' })
  ok(result.ok === true, 'uninstall plugin-b ok')
  ok(result.via === 'manual', 'manual runner used')
  ok(result.removedRows.includes('row-b'), 'row-b listed as removed row')

  const afterManifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  ok(!(afterManifest.dependencies ?? {})['plugin-b'], 'plugin-b dropped from dependencies')
  ok(!(afterManifest.dsh?.profile?.bundles ?? []).includes('plugin-b'), 'plugin-b dropped from bundles')
  ok(!existsSync(join(dir, 'node_modules', 'plugin-b')), 'plugin-b node_modules removed')
  const patchAfter = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
  ok(!/row-b/.test(patchAfter), 'disable entry cleaned after uninstall')
  const auditAfter = core.loadAudit(10)
  ok(auditAfter.some((e) => e.event === 'removed' && e.name === 'plugin-b'), 'audit records the removal')

  // aggregate still intact
  const afterPackages = core.listPackages(dir, anchors)
  ok(afterPackages.length === 2, `2 packages remain (got ${afterPackages.length})`)
  ok(afterPackages.some((p) => p.name === 'plugin-aggregate'), 'plugin-aggregate survives')
  delete process.env.DPM_DATA_DIR
  rmSync(dir, { recursive: true, force: true })
}

console.log('== fixture: marketplace helpers ==')
{
  const dir = makeFixture()
  const anchors = [join(dir, 'package.json')]
  ok(core.isMarketSpec('github:owner/repo') === true, 'accepts github spec')
  ok(core.isMarketSpec('github:owner/repo#v1.0.0') === true, 'accepts github spec with ref')
  ok(core.isMarketSpec('dsh-foo') === true, 'accepts npm package name')
  ok(core.isMarketSpec('@scope/dsh-foo') === true, 'accepts scoped npm package name')
  ok(core.isMarketSpec('owner/repo') === false, 'rejects bare owner/repo')
  ok(core.isMarketSpec('github:owner/repo; rm -rf /') === false, 'rejects shell injection')
  ok(core.normalizeGitHubRepo('https://github.com/Fixture/Plugin-A.git') === 'fixture/plugin-a', 'normalizes github url')
  const installed = core.installedMarketplaceSet(dir)
  ok(installed.has('fixture/plugin-a'), 'installed set includes fixture/plugin-a')
  const g = await core.installMarketPlugin(dir, anchors, 'fixture', 'bad spec')
  ok(g.ok === false && /invalid marketplace spec/.test(g.error), 'install refuses invalid spec')
  rmSync(dir, { recursive: true, force: true })
}

console.log('== real profile: read-only listing ==')
{
  const profileDir = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'profiles', 'web')
  if (!existsSync(join(profileDir, 'package.json'))) {
    console.error(`  ✗ profile not found at ${profileDir}; pass a real profile or run from the installed plugin`)
    failures += 1
  } else {
    console.log(`  profile: ${profileDir}`)
    const anchors = core.anchorsFor(profileDir)
  const plugins = core.listPlugins(profileDir, anchors)
  ok(plugins.length > 0, `listed ${plugins.length} rows`)
  const thirdParty = plugins.filter((p) => !p.protected)
  ok(thirdParty.length >= 8, `third-party rows: ${thirdParty.map((p) => `${p.rowId}(${p.name})`).join(', ')}`)
  const modlens = plugins.find((p) => p.name === '@liustack/modlens')
  ok(modlens && modlens.enabled === true, 'modlens present and enabled')
  ok(modlens && modlens.installedAt !== null, 'modlens installedAt present')
  const pet = plugins.find((p) => p.name === '@linxin666/dsh-pet')
  ok(pet && pet.protected === false, `dsh-pet row toggleable (rowId=${pet ? pet.rowId : '?'})`)
  const packages = core.listPackages(profileDir, anchors)
  ok(packages.length >= 4, `listPackages: ${packages.map((p) => `${p.name}@${p.version}(${p.rows.length}行)`).join(', ')}`)
  ok(packages.some((p) => p.name === '@liustack/modlens' && p.rows.includes('modlens')), 'modlens package lists its row')
  console.log('  sample rows:')
  for (const row of plugins.filter((p) => !p.protected).slice(0, 12)) {
    console.log(`    - ${row.rowId}  ${row.name}@${row.version ?? '?'}  ${row.enabled ? 'on' : 'OFF'}  src=${row.sourceBundle ?? '-'}  at=${row.installedAt ?? '-'}  repo=${row.repository ?? '-'}  reg=${row.registry ?? '-'}`)
  }
  }
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
