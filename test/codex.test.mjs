import test from 'node:test'
import assert from 'node:assert/strict'

const { apply, name, createHonoApp } = await import('../dist/index.js')

function makeCtx() {
  const tools = []
  tools.register = (t) => tools.push(t)
  return { tools }
}

test('exports name/apply/createHonoApp', () => {
  assert.equal(name, 'dsh-codex')
  assert.equal(typeof apply, 'function')
  assert.equal(typeof createHonoApp, 'function')
})

test('registers codex_status and codex_exec', () => {
  const ctx = makeCtx()
  apply(ctx)
  const names = ctx.tools.map((t) => t.name).sort()
  assert.deepEqual(names, ['codex_exec', 'codex_status'])
})

test('codex_status reports environment (may be missing binary)', async () => {
  const ctx = makeCtx()
  apply(ctx)
  const status = ctx.tools.find((t) => t.name === 'codex_status')
  const text = await status.execute({})
  assert.ok(typeof text === 'string' && text.length > 0)
  // always mentions binary presence and key status
  assert.match(text, /binary: (found|NOT FOUND)/)
  assert.match(text, /OPENAI_API_KEY: (set|NOT SET)/)
})

test('codex_exec without binary returns actionable guidance, not a throw', async () => {
  const ctx = makeCtx()
  apply(ctx)
  const exec = ctx.tools.find((t) => t.name === 'codex_exec')
  const out = await exec.execute({ prompt: 'test task' })
  assert.ok(typeof out === 'string')
  // either ran (has codex env) or told us what to install — never throws
  assert.ok(out.length > 0)
})

test('codex_exec validates missing prompt', async () => {
  const ctx = makeCtx()
  apply(ctx)
  const exec = ctx.tools.find((t) => t.name === 'codex_exec')
  await assert.rejects(() => exec.execute({}), /prompt is required/)
})

test('health endpoint responds 200', async () => {
  const app = createHonoApp({})
  const res = await app.fetch(new Request('http://localhost/api/codex/health'))
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.plugin, 'dsh-codex')
  assert.equal(body.hono, true)
})
