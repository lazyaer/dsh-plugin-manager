// dsh-plugin-manager · host half (cordis plugin).
//
// Mounts loopback-only HTTP routes under /api/dsh-plugin-manager and runs a
// lightweight audit poller that records every plugin install/update/remove
// (with source and time) into ~/.dsh/plugin-manager/audit.jsonl.
//
// Zero dsh package imports, like the modlens host half: the webServer
// service is acquired through a scoped ctx.inject, so the plugin stays inert
// on profiles without a web server.

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as core from './core.js'

export const name = 'plugin-manager'
export const inject = []

const MAX_JSON_BODY_BYTES = 64 * 1024

// Same loopback fence the dsh-web-ui-settings bridge uses: a route may only
// be reached from the machine itself, same origin.
function isLoopbackRequest(req) {
  const address = req.socket?.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = req.headers?.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (req.headers?.['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers?.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
  })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk
    size += buffer.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

export function apply(ctx) {
  let profileDir
  try {
    profileDir = core.findProfileRoot(import.meta.url)
  } catch (error) {
    console.error(`[plugin-manager] ${error?.message ?? error}`)
    return
  }
  const anchors = core.anchorsFor(profileDir)
  const profileName = core.profileNameOf(profileDir)

  let lastSig = ''
  const scan = () => {
    try {
      return core.scanNow(profileDir, anchors, profileName)
    } catch (error) {
      console.error(`[plugin-manager] audit scan failed: ${error?.message ?? error}`)
      return []
    }
  }
  try {
    lastSig = core.watchSignature(profileDir)
    scan()
  } catch (error) {
    console.error(`[plugin-manager] initial audit scan failed: ${error?.message ?? error}`)
  }

  const timer = setInterval(() => {
    const sig = core.watchSignature(profileDir)
    if (sig !== lastSig) {
      lastSig = sig
      scan()
    }
  }, 5000)
  if (typeof timer.unref === 'function') timer.unref()
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => clearInterval(timer), 'plugin-manager: audit polling')
  }

  if (typeof ctx.inject !== 'function') return
  ctx.inject(['webServer'], (scope) => {
    try {
      const disposers = registerRoutes(scope, { profileDir, anchors, profileName, scan })
      if (typeof scope.effect === 'function') {
        scope.effect(
          () => () => {
            for (const dispose of disposers) dispose()
          },
          'plugin-manager: routes',
        )
      }
    } catch (error) {
      console.error(`[plugin-manager] web routes skipped: ${error}`)
    }
  })
}

function registerRoutes(scope, deps) {
  const { webServer } = scope
  const guard = (req, res) => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { ok: false, error: 'loopback requests only' })
      return false
    }
    return true
  }
  const routes = [
    {
      kind: 'exact',
      path: '/api/dsh-plugin-manager/plugins',
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          writeJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        if (!guard(req, res)) return
        try {
          const plugins = core.listPlugins(deps.profileDir, deps.anchors)
          writeJson(res, 200, {
            ok: true,
            profile: deps.profileName,
            plugins,
            patchFile: join(deps.profileDir, 'cordis.patch.yml'),
            dataDir: core.dataDir(),
          })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-plugin-manager/plugins/toggle',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        if (!guard(req, res)) return
        const body = await readJsonBody(req)
        if (!body || typeof body.rowId !== 'string' || body.rowId === '' || typeof body.enabled !== 'boolean') {
          writeJson(res, 400, { ok: false, error: 'malformed body: {"rowId": string, "enabled": boolean} required' })
          return
        }
        try {
          const result = core.setPluginEnabled(deps.profileDir, deps.anchors, body.rowId, body.enabled)
          writeJson(res, result.ok ? 200 : 400, result)
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-plugin-manager/packages',
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          writeJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        if (!guard(req, res)) return
        try {
          writeJson(res, 200, { ok: true, packages: core.listPackages(deps.profileDir, deps.anchors) })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-plugin-manager/packages/uninstall',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        if (!guard(req, res)) return
        const body = await readJsonBody(req)
        if (!body || typeof body.packageName !== 'string' || body.packageName === '') {
          writeJson(res, 400, { ok: false, error: 'malformed body: {"packageName": string} required' })
          return
        }
        try {
          const result = await core.uninstallPackage(
            deps.profileDir,
            deps.anchors,
            deps.profileName,
            body.packageName,
          )
          writeJson(res, result.ok ? 200 : 400, result)
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-plugin-manager/market',
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          writeJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        if (!guard(req, res)) return
        try {
          const url = new URL(req.url ?? '', 'http://localhost')
          const options = {
            query: url.searchParams.get('q') ?? '',
            page: Number(url.searchParams.get('page')) || 1,
            perPage: Number(url.searchParams.get('perPage')) || 20,
          }
          const data = await core.listMarketplace(deps.profileDir, options)
          writeJson(res, 200, { ok: true, ...data })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-plugin-manager/market/install',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        if (!guard(req, res)) return
        const body = await readJsonBody(req)
        if (!body || typeof body.spec !== 'string' || body.spec === '') {
          writeJson(res, 400, { ok: false, error: 'malformed body: {"spec": string} required' })
          return
        }
        try {
          const result = await core.installMarketPlugin(
            deps.profileDir,
            deps.anchors,
            deps.profileName,
            body.spec,
            { timeoutMs: Number(body.timeoutMs) || undefined },
          )
          writeJson(res, result.ok ? 200 : 400, result)
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-plugin-manager/audit',
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          writeJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        if (!guard(req, res)) return
        try {
          writeJson(res, 200, { ok: true, entries: core.loadAudit(300), dataDir: core.dataDir() })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-plugin-manager/audit/rescan',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        if (!guard(req, res)) return
        try {
          const entries = deps.scan()
          writeJson(res, 200, { ok: true, entries })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    },
  ]
  return routes.map((route) => webServer.register(route))
}
