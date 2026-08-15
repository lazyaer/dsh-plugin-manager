// E2E toggle helper: node e2e-toggle.mjs <disable|enable|baseline>
// Mutates the REAL web profile's cordis.patch.yml for the dsh-pet row.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as core from '../lib/core.js'

const profileDir = join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'web')
const anchors = core.anchorsFor(profileDir)
const action = process.argv[2] ?? 'baseline'

if (action === 'baseline') {
  const events = core.scanNow(profileDir, anchors, 'web')
  console.log(`audit baseline: ${events.length} entries → ${events.map((e) => `${e.event}:${e.name}@${e.version ?? '?'}`).join(', ')}`)
  process.exit(0)
}

const plugins = core.listPlugins(profileDir, anchors)
const pet = plugins.find((p) => p.name === '@linxin666/dsh-pet')
if (!pet) {
  console.error('pet row not found')
  process.exit(1)
}
console.log(`pet row: rowId=${pet.rowId} enabled=${pet.enabled} protected=${pet.protected}`)
if (pet.protected) {
  console.error('pet is protected; aborting')
  process.exit(1)
}

const result = core.setPluginEnabled(profileDir, anchors, pet.rowId, action === 'enable')
console.log(`toggle ${action}: ok=${result.ok} ${result.error ?? ''}`)
const after = core.listPlugins(profileDir, anchors)
const now = after.find((p) => p.rowId === pet.rowId)
console.log(`pet enabled now: ${now?.enabled}`)
console.log('--- cordis.patch.yml ---')
console.log(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'))
process.exit(result.ok ? 0 : 1)
