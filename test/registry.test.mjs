import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { addAnchors, loadRegistry, removeAnchorExactly, resolveAnchorsFile } from '../src/registry.js'

test('automatic registry is outside the project workspace and isolated by workspace', () => {
  const root = mkdtempSync(join(tmpdir(), 'premise-guard-'))
  const config = { anchorsStoreDir: root }
  const a = resolveAnchorsFile(config, { header: { cwd: 'C:/novel/a' } })
  const b = resolveAnchorsFile(config, { header: { cwd: 'C:/novel/b' } })
  assert.match(a, /workspaces/); assert.notEqual(a, b); assert.ok(!a.includes('C:/novel/a'))
})

test('add is deduplicated and remove is exact, atomic writes preserve a backup', () => {
  const root = mkdtempSync(join(tmpdir(), 'premise-guard-')); const file = join(root, 'anchors.md')
  assert.deepEqual(addAnchors(file, '甲\n- 乙\n甲'), ['甲', '乙'])
  assert.deepEqual(loadRegistry(file), ['甲', '乙'])
  assert.equal(removeAnchorExactly(file, '甲乙').removed, false)
  assert.equal(removeAnchorExactly(file, '甲').removed, true)
  assert.deepEqual(loadRegistry(file), ['乙'])
  assert.match(readFileSync(`${file}.bak`, 'utf8'), /甲/)
})
