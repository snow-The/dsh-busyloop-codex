import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { apply, name, inject, detectEnvironment, activeProviderEnvKey, createHttpHandler, handleHttp } =
  await import('../dist/index.js')

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** A throwaway CODEX_HOME, so credential detection never reads the real ~/.codex. */
function fakeCodexHome() {
  return mkdtempSync(join(tmpdir(), 'codex-home-'))
}

/**
 * Run `fn` with CODEX_HOME pointed at a fresh temp dir and the given env applied.
 * Every variable is restored to its EXACT prior state -- including deleting it when it was unset,
 * because assigning `undefined` to process.env stores the literal string "undefined", which is
 * truthy and silently poisons later checks.
 */
async function withSandbox(envVars, fn) {
  const home = fakeCodexHome()
  const saved = { CODEX_HOME: process.env.CODEX_HOME }
  for (const k of Object.keys(envVars)) saved[k] = process.env[k]
  process.env.CODEX_HOME = home
  for (const [k, v] of Object.entries(envVars)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return await fn(home)
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(home, { recursive: true, force: true, maxRetries: 3 })
  }
}

function writeConfig(home, toml) {
  writeFileSync(join(home, 'config.toml'), toml, 'utf8')
}

function makeCtx() {
  const tools = []
  tools.register = (t) => tools.push(t)
  return { tools, inject() {} }
}

/** Minimal node req/res pair for the native handler. */
function fakePair({ url = '/api/codex/health', method = 'GET', withConnection = true, rejection } = {}) {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k] = v },
    writeHead(s, h) { this.statusCode = s; Object.assign(this.headers, h ?? {}) },
    end(b) { if (b !== undefined) this.body = String(b) },
  }
  const ctx = withConnection
    ? { get: (n) => (n === 'connection' ? { requestRejection: () => rejection } : undefined) }
    : {}
  return { req: { url, method, headers: {} }, res, ctx }
}

// ---------------------------------------------------------------------------
// module contract
// ---------------------------------------------------------------------------

test('module exposes the loader contract', () => {
  assert.equal(name, 'dsh-codex')
  assert.deepEqual(inject, ['tools'])
  assert.equal(typeof apply, 'function')
})

test('registers codex_status and codex_exec', () => {
  const ctx = makeCtx()
  apply(ctx)
  const names = ctx.tools.map((t) => t.name).sort()
  assert.deepEqual(names, ['codex_exec', 'codex_status'])
})

// ---------------------------------------------------------------------------
// activeProviderEnvKey -- the parser that makes the plugin provider-aware
// ---------------------------------------------------------------------------

test('activeProviderEnvKey reads the env_key of the ACTIVE provider only', () => {
  const toml = `
model_provider = "copilot-gw"
model = "gpt-4o"

[model_providers.other]
base_url = "https://example.invalid"
env_key = "OTHER_KEY"

[model_providers.copilot-gw]
name = "GitHub Copilot (student Pro)"
base_url = "https://api.githubcopilot.com"
env_key = "COPILOT_TOKEN"
wire_api = "responses"
`
  assert.deepEqual(activeProviderEnvKey(toml), { provider: 'copilot-gw', envKey: 'COPILOT_TOKEN' })
})

test('activeProviderEnvKey tolerates quoting, comments and a missing provider', () => {
  // quoted section name + single quotes + a commented-out provider
  const quoted = `
model_provider = 'deepseek'
# [model_providers.disabled]
# env_key = "NOPE"
[model_providers."deepseek"]
env_key = "DEEPSEEK_API_KEY"
`
  assert.deepEqual(activeProviderEnvKey(quoted), { provider: 'deepseek', envKey: 'DEEPSEEK_API_KEY' })

  // no provider configured at all: must report "cannot tell", never a wrong name
  assert.deepEqual(activeProviderEnvKey('model = "gpt-5"\n'), { provider: null, envKey: null })

  // a provider whose section carries no env_key
  assert.deepEqual(activeProviderEnvKey('model_provider = "x"\n[model_providers.x]\nbase_url = "u"\n'),
    { provider: 'x', envKey: null })
})

// ---------------------------------------------------------------------------
// credential detection -- the three paths, and the precedence between them
// ---------------------------------------------------------------------------

test('credentials: the active provider env_key is honoured (the case the old gate missed)', async () => {
  await withSandbox({ COPILOT_TOKEN: 'tok', OPENAI_API_KEY: undefined }, async (home) => {
    writeConfig(home, 'model_provider = "copilot-gw"\n[model_providers.copilot-gw]\nenv_key = "COPILOT_TOKEN"\n')
    const env = detectEnvironment()
    assert.equal(env.credentials.ok, true)
    assert.equal(env.credentials.via, 'provider-env-key')
    assert.equal(env.credentials.source, 'COPILOT_TOKEN')
    assert.equal(env.credentials.provider, 'copilot-gw')
    assert.equal(env.hasApiKey, true, 'the legacy alias must agree')
  })
})

test('credentials: a configured provider with an unset env_key is a real problem, and is named', async () => {
  await withSandbox({ COPILOT_TOKEN: undefined, OPENAI_API_KEY: undefined }, async (home) => {
    writeConfig(home, 'model_provider = "copilot-gw"\n[model_providers.copilot-gw]\nenv_key = "COPILOT_TOKEN"\n')
    const env = detectEnvironment()
    assert.equal(env.credentials.ok, false)
    assert.equal(env.credentials.provider, 'copilot-gw')
    assert.ok(env.notes.some((n) => n.includes('COPILOT_TOKEN')),
      `the report must name the missing variable; got: ${JSON.stringify(env.notes)}`)
  })
})

test('credentials: auth.json (the `codex login` path) counts as authenticated', async () => {
  await withSandbox({ OPENAI_API_KEY: undefined }, async (home) => {
    writeFileSync(join(home, 'auth.json'), '{"tokens":{}}', 'utf8')
    const env = detectEnvironment()
    assert.equal(env.credentials.ok, true)
    assert.equal(env.credentials.via, 'oauth-auth-json')
    assert.equal(env.credentials.authFile, join(home, 'auth.json'))
  })
})

test('credentials: OPENAI_API_KEY still works, and is the LAST resort', async () => {
  await withSandbox({ OPENAI_API_KEY: 'sk-test' }, async (home) => {
    writeConfig(home, 'model_provider = "p"\n[model_providers.p]\nenv_key = "NOT_SET_VAR"\n')
    const env = detectEnvironment()
    assert.equal(env.credentials.ok, true)
    assert.equal(env.credentials.via, 'openai-api-key')
  })

  // provider credential present => it wins over a bare OPENAI_API_KEY
  await withSandbox({ OPENAI_API_KEY: 'sk-test', PROV_KEY: 'x' }, async (home) => {
    writeConfig(home, 'model_provider = "p"\n[model_providers.p]\nenv_key = "PROV_KEY"\n')
    const env = detectEnvironment()
    assert.equal(env.credentials.via, 'provider-env-key')
  })
})

test('credentials: nothing configured reports MISSING and lists all three routes', async () => {
  await withSandbox({ OPENAI_API_KEY: undefined }, async () => {
    const env = detectEnvironment()
    assert.equal(env.credentials.ok, false)
    assert.equal(env.credentials.via, 'none')
    const joined = env.notes.join(' ')
    assert.match(joined, /codex login/)
    assert.match(joined, /env_key/)
    assert.match(joined, /OPENAI_API_KEY/)
  })
})

test('CODEX_HOME is treated as the codex dir, not a parent of .codex', async () => {
  // The old code did join(codexHome, '.codex', 'config.toml') -> <CODEX_HOME>/.codex/config.toml,
  // which silently finds nothing when CODEX_HOME is set.
  await withSandbox({ OPENAI_API_KEY: undefined }, async (home) => {
    writeConfig(home, 'model_provider = "p"\n[model_providers.p]\nenv_key = "K"\n')
    const env = detectEnvironment()
    assert.equal(env.configFile, join(home, 'config.toml'))
    assert.equal(env.credentials.provider, 'p')
  })
})

// ---------------------------------------------------------------------------
// HTTP surface -- the fence is the security-relevant part
// ---------------------------------------------------------------------------

test('http: an unreachable fence fails CLOSED (503), it never becomes an open route', () => {
  const { req, res } = fakePair({ withConnection: false })
  createHttpHandler({})(req, res)
  assert.equal(res.statusCode, 503)
  assert.match(res.body, /fence cannot be applied/)
})

test('http: a rejecting fence answers with its status and does not reach the route', () => {
  const { req, res, ctx } = fakePair({ rejection: 403 })
  createHttpHandler(ctx)(req, res)
  assert.equal(res.statusCode, 403)
  assert.equal(res.body, '', 'the fence must answer bare, without leaking route data')
})

test('http: an admitting fence lets the route answer', () => {
  const { req, res, ctx } = fakePair({ rejection: undefined })
  createHttpHandler(ctx)(req, res)
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.equal(body.plugin, 'dsh-codex')
})

test('http: routing, method guard and 404', () => {
  const status = fakePair({ url: '/api/codex/status' })
  handleHttp(status.req, status.res)
  assert.equal(status.res.statusCode, 200)
  assert.ok(Object.prototype.hasOwnProperty.call(JSON.parse(status.res.body), 'credentials'),
    'the status route must expose the credential verdict')

  // query strings must not defeat the route match
  const withQuery = fakePair({ url: '/api/codex/health?x=1' })
  handleHttp(withQuery.req, withQuery.res)
  assert.equal(withQuery.res.statusCode, 200)

  const post = fakePair({ method: 'POST' })
  handleHttp(post.req, post.res)
  assert.equal(post.res.statusCode, 405)
  assert.equal(post.res.headers.allow, 'GET')

  const missing = fakePair({ url: '/api/codex/nope' })
  handleHttp(missing.req, missing.res)
  assert.equal(missing.res.statusCode, 404)
})

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

test('codex_status reports the credential path as a sentence, not a bare boolean', async () => {
  const ctx = makeCtx()
  apply(ctx)
  const status = ctx.tools.find((t) => t.name === 'codex_status')
  const text = await status.execute({})
  assert.match(text, /binary: (found|NOT FOUND)/)
  assert.match(text, /credentials: (ok|MISSING)/)
  assert.match(text, /auth\.json:/)
  // The old line hard-coded OPENAI_API_KEY as the one path; it must now be labelled as one of three.
  assert.match(text, /one of three possible paths/)
})

test('codex_exec rejects a call with no prompt, before touching the environment', async () => {
  const ctx = makeCtx()
  apply(ctx)
  const exec = ctx.tools.find((t) => t.name === 'codex_exec')
  // Two layers can raise this and BOTH are correct: the host validates the declared `parameters`
  // schema first (ToolArgsError: missing required property "prompt"), and the plugin's own guard is
  // a backstop. Which one wins depends on whether the real @deepseek-ai/dsh-tools is installed, so
  // the assertion requires a rejection that NAMES the prompt rather than one specific wording --
  // pinning the plugin's phrasing would break the moment the host got stricter, which is an
  // improvement, not a regression.
  await assert.rejects(
    () => exec.execute({}),
    (err) => {
      assert.match(String(err?.message ?? err), /prompt/i)
      return true
    },
  )
})
