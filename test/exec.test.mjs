/**
 * runCodexExec 全链路测试:用 fake codex 二进制(fake/bin/codex.cmd + codex.js)验证
 * spawn 参数、stdin prompt、--output-last-message 文件通道、stderr 回显、退出码、超时 kill。
 * 不碰真 Codex CLI、不耗 API 额度。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'

const { runCodexExec, validateExtraArgs } = await import('../dist/index.js')

const FAKE_CODEX_JS = `
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
if (args.includes('--version')) {
  process.stdout.write('codex-cli 9.9.9-fake\\n')
  process.exit(0)
}
const record = process.env.FAKE_CODEX_RECORD_DIR
if (record) {
  writeFileSync(join(record, 'argv.json'), JSON.stringify(args))
}
let outFile = null
for (let i = 0; i < args.length - 1; i++) {
  if (args[i] === '--output-last-message') outFile = args[i + 1]
}
let stdin = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => { stdin += d })
process.stdin.on('end', () => {
  if (record) writeFileSync(join(record, 'stdin.txt'), stdin)
  const sleep = Number(process.env.FAKE_CODEX_SLEEP_MS ?? 0)
  const exit = Number(process.env.FAKE_CODEX_EXIT ?? 0)
  const stderr = process.env.FAKE_CODEX_STDERR ?? ''
  setTimeout(() => {
    if (stderr) process.stderr.write(stderr)
    if (outFile && !process.env.FAKE_CODEX_NO_LAST) {
      writeFileSync(outFile, process.env.FAKE_CODEX_LAST ?? 'fake last message')
    }
    process.exit(exit)
  }, sleep)
})
`

let fakeDir = null
let recordDir = null
const savedEnv = {}

async function setupFake() {
  fakeDir = await mkdtemp(join(tmpdir(), 'dsh-codex-fake-'))
  recordDir = join(fakeDir, 'record')
  await mkdir(recordDir)
  // 注意:必须用 .mjs 扩展名 —— 无 package.json 的目录里 .js 按 CJS 解析,静态 import 会 SyntaxError
  await writeFile(join(fakeDir, 'codex.mjs'), FAKE_CODEX_JS)
  await writeFile(join(fakeDir, 'codex.cmd'), '@echo off\r\nnode "%~dp0codex.mjs" %*\r\n')
  savedEnv.PATH = process.env.PATH
  savedEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY
  for (const k of ['FAKE_CODEX_RECORD_DIR', 'FAKE_CODEX_LAST', 'FAKE_CODEX_NO_LAST', 'FAKE_CODEX_STDERR', 'FAKE_CODEX_EXIT', 'FAKE_CODEX_SLEEP_MS']) {
    savedEnv[k] = process.env[k]
  }
  process.env.PATH = `${fakeDir}${delimiter}${process.env.PATH}`
  process.env.OPENAI_API_KEY = 'test-key'
  process.env.FAKE_CODEX_RECORD_DIR = recordDir
  // reset behaviors per test
  delete process.env.FAKE_CODEX_LAST
  delete process.env.FAKE_CODEX_NO_LAST
  delete process.env.FAKE_CODEX_STDERR
  delete process.env.FAKE_CODEX_EXIT
  delete process.env.FAKE_CODEX_SLEEP_MS
}

async function teardownFake() {
  for (const k of Object.keys(savedEnv)) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  if (fakeDir) await rm(fakeDir, { recursive: true, force: true }).catch(() => {})
}

async function readRecord(name) {
  return readFile(join(recordDir, name), 'utf8')
}

test('setup: fake codex resolves on PATH', async () => {
  await setupFake()
  try {
    // Windows 上 .cmd shim 必须 shell:true 才能解析执行
    const { execFileSync } = await import('node:child_process')
    const out = execFileSync('codex.cmd', ['--version'], { encoding: 'utf8', shell: true })
    assert.match(out, /9\.9\.9-fake/)
  } finally {
    // 保持 fake 环境给后续测试(串行执行,node --test 文件内默认串行)
  }
})

test('runCodexExec: success path — last message read back, prompt via stdin', async () => {
  const out = await runCodexExec({ prompt: 'fix the bug', cwd: fakeDir })
  assert.match(out, /exit code: 0/)
  assert.match(out, /fake last message/)
  const argv = JSON.parse(await readRecord('argv.json'))
  assert.ok(argv.includes('exec'))
  assert.ok(argv.includes('--skip-git-repo-check'))
  assert.ok(argv.includes('--cd'))
  assert.ok(argv.includes('--output-last-message'))
  const stdin = await readRecord('stdin.txt')
  assert.equal(stdin, 'fix the bug')
})

test('runCodexExec: model / reasoningEffort / safe extraArgs passthrough', async () => {
  await runCodexExec({
    prompt: 'p',
    model: 'codex-mini-latest',
    reasoningEffort: 'high',
    extraArgs: ['--verbose'],
  })
  const argv = JSON.parse(await readRecord('argv.json'))
  assert.ok(argv.includes('--model') && argv[argv.indexOf('--model') + 1] === 'codex-mini-latest')
  assert.ok(argv.includes('--reasoning-effort') && argv[argv.indexOf('--reasoning-effort') + 1] === 'high')
  assert.ok(argv.includes('--verbose'))
})

test('runCodexExec: protected args rejected before spawn', async () => {
  await assert.rejects(
    () => runCodexExec({ prompt: 'p', extraArgs: ['--json'] }),
    /refusing protected codex args: --json/,
  )
  await assert.rejects(
    () => runCodexExec({ prompt: 'p', extraArgs: ['--sandbox', 'danger', '--model', 'x'] }),
    /refusing protected codex args: --sandbox, --model/,
  )
})

test('validateExtraArgs: direct unit checks', () => {
  assert.doesNotThrow(() => validateExtraArgs(undefined))
  assert.doesNotThrow(() => validateExtraArgs([]))
  assert.doesNotThrow(() => validateExtraArgs(['--verbose', '--full-sandbox']))
  assert.throws(() => validateExtraArgs(['--profile', 'prod']), /--profile/)
  assert.throws(() => validateExtraArgs(['--output-json']), /--output-json/)
})

test('runCodexExec: nonzero exit reported', async () => {
  process.env.FAKE_CODEX_EXIT = '2'
  process.env.FAKE_CODEX_LAST = 'partial work'
  const out = await runCodexExec({ prompt: 'p' })
  assert.match(out, /exit code: 2/)
  assert.match(out, /partial work/)
  delete process.env.FAKE_CODEX_EXIT
  delete process.env.FAKE_CODEX_LAST
})

test('runCodexExec: stderr echoed when no last-message file', async () => {
  process.env.FAKE_CODEX_NO_LAST = '1'
  process.env.FAKE_CODEX_STDERR = 'boom from codex'
  const out = await runCodexExec({ prompt: 'p' })
  assert.match(out, /\[stderr\]/)
  assert.match(out, /boom from codex/)
  delete process.env.FAKE_CODEX_NO_LAST
  delete process.env.FAKE_CODEX_STDERR
})

test('runCodexExec: timeout kills child', async () => {
  process.env.FAKE_CODEX_SLEEP_MS = '20000'
  const t0 = Date.now()
  const out = await runCodexExec({ prompt: 'p', timeoutMs: 300 })
  assert.match(out, /timed out, killed/)
  assert.ok(Date.now() - t0 < 10000, 'should not wait for the fake sleep')
  delete process.env.FAKE_CODEX_SLEEP_MS
})

test('runCodexExec: no binary on PATH returns install guidance', async () => {
  // 把 PATH 换成不含 codex 的目录
  const originalPath = process.env.PATH
  process.env.PATH = tmpdir()
  try {
    const out = await runCodexExec({ prompt: 'p' })
    assert.match(out, /codex CLI not available/)
    assert.match(out, /npm install -g @openai\/codex/)
  } finally {
    process.env.PATH = originalPath
  }
})

test('runCodexExec: no API key returns auth guidance', async () => {
  const originalKey = process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEY
  try {
    const out = await runCodexExec({ prompt: 'p' })
    assert.match(out, /OPENAI_API_KEY is not set/)
  } finally {
    process.env.OPENAI_API_KEY = originalKey
  }
})

test('teardown: restore env and remove fake', async () => {
  await teardownFake()
  assert.equal(process.env.OPENAI_API_KEY, savedEnv.OPENAI_API_KEY)
})
