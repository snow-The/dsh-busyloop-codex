/**
 * compat.test.mjs — 证明反向兼容的两条纪律真的生效。
 *
 * 对照官方 openai/codex-plugin-cc 的做法（2026-10-19 重读）：
 *   (a) 窄口径抑制：只在错误确实是"不认识这个参数"时降级；
 *       认证/网络错误必须【不重试】，原样返回。
 *   (b) 能力探测：按 `codex exec --help` 实际暴露的 flag 面构建参数，
 *       而不是硬假设本地 codex 支持某个 flag。
 *
 * 全部用 fake codex 二进制，不碰真 CLI、不耗额度。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'

const { runCodexExec, probeExecCapabilities } = await import('../dist/index.js')

const FAKE = `
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const record = process.env.FAKE_RECORD_DIR
if (record) appendFileSync(join(record, 'argv-log.jsonl'), JSON.stringify(args) + '\\n')

if (args.includes('--version')) {
  process.stdout.write('codex-cli 9.9.9-fake\\n')
  process.exit(0)
}

// 探测：codex exec --help
if (args[0] === 'exec' && args.includes('--help')) {
  const mode = process.env.FAKE_HELP_MODE ?? 'full'
  const flags = mode === 'full'
    ? ['--cd', '--skip-git-repo-check', '--output-last-message', '--reasoning-effort', '--model', '--json']
    : mode === 'no-last-message'
      ? ['--cd', '--skip-git-repo-check', '--json', '--model']
      : ['--cd']
  process.stdout.write('Usage: codex exec [OPTIONS]\\n\\n' + flags.map((f) => '  ' + f + ' <value>').join('\\n') + '\\n')
  process.exit(0)
}

const authFail = process.env.FAKE_FAIL_KIND === 'auth'
const rejectFlag = process.env.FAKE_REJECT_FLAG

// 模拟"这个版本不认识某个参数"
if (rejectFlag && args.includes(rejectFlag)) {
  process.stderr.write("error: unexpected argument '" + rejectFlag + "' found\\n")
  process.exit(2)
}

if (authFail) {
  process.stderr.write('401 Unauthorized: token expired\\n')
  process.exit(1)
}

let stdin = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => { stdin += d })
process.stdin.on('end', () => {
  if (record) writeFileSync(join(record, 'stdin.txt'), stdin)
  let outFile = null
  for (let i = 0; i < args.length - 1; i++) if (args[i] === '--output-last-message') outFile = args[i + 1]
  if (outFile) writeFileSync(outFile, 'message from file channel')
  process.stdout.write('message from stdout\\n')
  process.exit(0)
})
`

let fakeDir = null
let recordDir = null
const saved = {}

async function setup() {
  fakeDir = await mkdtemp(join(tmpdir(), 'dsh-compat-fake-'))
  recordDir = join(fakeDir, 'record')
  await mkdir(recordDir)
  await writeFile(join(fakeDir, 'codex.mjs'), FAKE)
  await writeFile(join(fakeDir, 'codex.cmd'), '@echo off\r\nnode "%~dp0codex.mjs" %*\r\n')

  for (const k of ['PATH', 'OPENAI_API_KEY', 'FAKE_RECORD_DIR', 'FAKE_HELP_MODE', 'FAKE_FAIL_KIND', 'FAKE_REJECT_FLAG']) {
    saved[k] = process.env[k]
  }
  process.env.PATH = `${fakeDir}${delimiter}${process.env.PATH}`
  process.env.OPENAI_API_KEY = 'test-key'
  process.env.FAKE_RECORD_DIR = recordDir
  delete process.env.FAKE_HELP_MODE
  delete process.env.FAKE_FAIL_KIND
  delete process.env.FAKE_REJECT_FLAG
  probeExecCapabilities(true)   // 清掉上一个用例缓存的能力
}

async function teardown() {
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  if (fakeDir) await rm(fakeDir, { recursive: true, force: true }).catch(() => {})
}

async function invocations() {
  try {
    const raw = await readFile(join(recordDir, 'argv-log.jsonl'), 'utf8')
    return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch { return [] }
}

test('探测：读 `codex exec --help` 得出能力面', async () => {
  await setup()
  try {
    const caps = probeExecCapabilities(true)
    assert.equal(caps.probed, true, '应当解析成功')
    assert.equal(caps.outputLastMessage, true)
    assert.equal(caps.skipGitRepoCheck, true)
    assert.equal(caps.reasoningEffort, true)

    process.env.FAKE_HELP_MODE = 'no-last-message'
    const caps2 = probeExecCapabilities(true)
    assert.equal(caps2.probed, true)
    assert.equal(caps2.outputLastMessage, false, '该版本没有 --output-last-message')
  } finally { await teardown() }
})

test('能力缺失时不硬用该 flag：改走 stdout 通道', async () => {
  await setup()
  try {
    process.env.FAKE_HELP_MODE = 'no-last-message'
    probeExecCapabilities(true)

    const out = await runCodexExec({ prompt: 'hello', cwd: fakeDir })
    assert.match(out, /exit code: 0/)
    assert.match(out, /message from stdout/, '应当回退到 stdout 里的消息')

    const calls = await invocations()
    const execCall = calls.filter((a) => a[0] === 'exec' && !a.includes('--help')).pop()
    assert.ok(execCall, '应当有一次真正的 exec 调用')
    assert.ok(!execCall.includes('--output-last-message'), '不支持的 flag 不能出现')
  } finally { await teardown() }
})

test('窄口径降级：不认识参数 → 用最小参数集重试一次', async () => {
  await setup()
  try {
    process.env.FAKE_REJECT_FLAG = '--reasoning-effort'
    probeExecCapabilities(true)

    const out = await runCodexExec({ prompt: 'hello', cwd: fakeDir, reasoningEffort: 'high' })
    assert.match(out, /\[compat\]/, '必须在输出里写明发生了降级')
    assert.match(out, /Retried with the minimal flag set/)
    assert.match(out, /exit code: 0/, '降级后应当成功')

    const execCalls = (await invocations()).filter((a) => a[0] === 'exec' && !a.includes('--help'))
    assert.equal(execCalls.length, 2, '应当恰好重试一次')
    assert.ok(execCalls[0].includes('--reasoning-effort'), '第一次带上了该 flag')
    assert.ok(!execCalls[1].includes('--reasoning-effort'), '重试时不带该 flag')
  } finally { await teardown() }
})

test('认证错误不降级：只调用一次，错误原样返回', async () => {
  await setup()
  try {
    process.env.FAKE_FAIL_KIND = 'auth'
    probeExecCapabilities(true)

    const out = await runCodexExec({ prompt: 'hello', cwd: fakeDir })
    assert.match(out, /exit code: 1/)
    assert.match(out, /401 Unauthorized/, '认证错误必须原样透出')
    assert.doesNotMatch(out, /\[compat\]/, '认证错误不是版本问题，不能写降级说明')

    const execCalls = (await invocations()).filter((a) => a[0] === 'exec' && !a.includes('--help'))
    assert.equal(execCalls.length, 1, '认证错误不许重试 —— 这是官方 "Rethrow auth, network, or server errors" 的同一条原则')
  } finally { await teardown() }
})
