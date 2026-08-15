import assert from 'node:assert/strict'
import { apply } from '../src/index.js'

const registered = {}
const ctx = {
  on() {},
  effect(callback) { callback() },
  get(name) {
    if (name === 'tools') return { register(definition) { registered.tool = definition } }
    if (name === 'commands') return { register(definition) { registered.command = definition } }
    return undefined
  },
}

apply(ctx, {})
assert.equal(registered.tool.name, 'premise_anchor')
assert.equal(registered.command.name, 'anchor')
const listed = await registered.tool.execute({ action: 'list' }, { agent: {} })
assert.equal(listed.ok, true)
console.log('Plugin registration smoke test passed')
