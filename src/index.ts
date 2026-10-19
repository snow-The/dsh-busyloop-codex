/**
 * dsh-codex — OpenAI Codex as a DSH ecosystem plugin (TypeScript + Hono).
 *
 * Tools:
 *   codex_status — environment detection (binary / CODEX_HOME / config / provider / credential path).
 *   codex_exec   — run one Codex task via `codex exec` (stdin prompt,
 *                  --output-last-message file channel).
 *
 * HTTP (Hono): createHonoApp(ctx) exposes /api/codex/status as a fetch
 * handler. The plugin tries to mount it on the host's http service when one
 * is available; otherwise the app is still exported for manual mounting.
 *
 * Design absorbed from codex-zone research:
 *   - codex-action: spawn + stdin + file channel + protected-arg validation
 *   - hono: app.fetch is a pure (Request)=>Response, env carries ctx
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { execFileSync } from 'node:child_process';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export const name = 'dsh-codex';
export const inject = ['tools'];

// Windows 上 npm 全局安装的 codex 是 codex.cmd shim:
// 无 shell 的 spawn/execFileSync 对 .cmd 直接 ENOENT/EINVAL,必须 shell: true。
const IS_WIN = process.platform === 'win32';
const CODEX_BIN = IS_WIN ? 'codex.cmd' : 'codex';

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export interface CodexEnv {
  hasCodexBin: boolean;
  codexVersion: string | null;
  codexHome: string | null;
  /** Kept for backwards compatibility with existing callers; see `credentials` for what it means. */
  hasApiKey: boolean;
  /**
   * How Codex will authenticate, and which of the three supported paths supplied it.
   *
   * The old check was `Boolean(process.env.OPENAI_API_KEY)` and that was simply wrong: Codex
   * authenticates via (a) `codex login` OAuth stored in `~/.codex/auth.json`, (b) the `env_key` that
   * the ACTIVE provider in `config.toml` names -- which is not necessarily OPENAI_API_KEY -- or
   * (c) a legacy OPENAI_API_KEY. Checking only (c) makes the plugin refuse to run on a machine that
   * is already configured and working, which is exactly what happened here: a
   * `[model_providers.copilot-gw]` setup with its own env var was reported as
   * "Codex cannot authenticate".
   */
  credentials: {
    ok: boolean;
    via: 'openai-api-key' | 'provider-env-key' | 'oauth-auth-json' | 'none';
    /** The env var that supplied the credential, when one did (may be a provider-specific name). */
    source: string | null;
    /** `model_provider` from config.toml, when one is configured. */
    provider: string | null;
    authFile: string | null;
  };
  configFile: string | null;
  notes: string[];
}

export interface ExecOptions {
  prompt: string;
  cwd?: string;
  model?: string;
  reasoningEffort?: string;
  extraArgs?: string[];
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// environment detection
// ---------------------------------------------------------------------------

/**
 * Read the `env_key` of the ACTIVE model provider out of a Codex `config.toml`.
 *
 * Deliberately a targeted scan rather than a TOML parser: adding a dependency (or hand-rolling a
 * full parser) to read two keys is not worth it, and being wrong here only downgrades a diagnostic,
 * never a decision -- the caller treats an unknown provider as "cannot tell", not as "no credential".
 *
 * Exported for tests: this is the piece that makes the plugin provider-aware, so it is the piece
 * worth pinning.
 */
export function activeProviderEnvKey(toml: string): { provider: string | null; envKey: string | null } {
  const lines = toml.split(/\r?\n/);
  const top = /^\s*model_provider\s*=\s*["']([^"']+)["']/;
  // Both `[model_providers.<name>]` and `[model_providers."<name>"]` occur in the wild.
  const header = /^\s*\[model_providers\.(?:"([^"]+)"|'([^']+)'|([^\]]+))\]/;
  const envKeyRe = /^\s*env_key\s*=\s*["']([^"']+)["']/;

  let provider: string | null = null;
  let section: string | null = null;
  const envKeys: Record<string, string> = {};

  for (const line of lines) {
    const t = top.exec(line);
    if (t) { provider = t[1]; continue; }
    const h = header.exec(line);
    if (h) { section = (h[1] ?? h[2] ?? h[3] ?? '').trim(); continue; }
    if (/^\s*\[/.test(line)) { section = null; continue; }
    const e = envKeyRe.exec(line);
    if (e && section) envKeys[section] = e[1];
  }
  return { provider, envKey: provider ? (envKeys[provider] ?? null) : null };
}

export function detectEnvironment(): CodexEnv {
  const env: CodexEnv = {
    hasCodexBin: false,
    codexVersion: null,
    codexHome: process.env.CODEX_HOME ?? null,
    hasApiKey: false,
    credentials: { ok: false, via: 'none', source: null, provider: null, authFile: null },
    configFile: null,
    notes: [],
  };
  for (const bin of [CODEX_BIN, 'codex', 'codex.exe']) {
    try {
      const out = execFileSync(bin, ['--version'], {
        encoding: 'utf8',
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: IS_WIN && bin.endsWith('.cmd'),
      });
      env.hasCodexBin = true;
      env.codexVersion = out.split('\n')[0]?.trim() ?? '';
      break;
    } catch {
      /* keep looking */
    }
  }
  if (!env.hasCodexBin) {
    env.notes.push('codex binary not found on PATH. Install with: npm install -g @openai/codex');
  }

  // CODEX_HOME *is* the codex directory; the default is <home>/.codex. Joining '.codex' onto
  // CODEX_HOME would look for <CODEX_HOME>/.codex/config.toml and silently find nothing.
  const codexDir = env.codexHome ?? join(homedir(), '.codex');
  const cfg = join(codexDir, 'config.toml');
  if (existsSync(cfg)) env.configFile = cfg;

  // Path (a): OAuth from `codex login`.
  const authFile = join(codexDir, 'auth.json');
  if (existsSync(authFile)) {
    env.credentials = { ok: true, via: 'oauth-auth-json', source: 'auth.json', provider: null, authFile };
  }

  // Path (b): the env var the ACTIVE provider names -- the case the old code missed.
  let provider: string | null = null;
  if (env.configFile) {
    try {
      const { provider: p, envKey } = activeProviderEnvKey(readFileSync(env.configFile, 'utf8'));
      provider = p;
      env.credentials.provider = p;
      if (envKey) {
        const present = Boolean(process.env[envKey]);
        if (present) {
          env.credentials = { ok: true, via: 'provider-env-key', source: envKey, provider: p, authFile: env.credentials.authFile };
        } else if (!env.credentials.ok) {
          env.notes.push(`provider "${p}" is configured but its env var ${envKey} is not set -- Codex cannot authenticate.`);
        }
      }
    } catch {
      env.notes.push(`could not read ${env.configFile}.`);
    }
  }

  // Path (c): legacy OPENAI_API_KEY. Lowest precedence, because a configured provider overrides it.
  if (!env.credentials.ok && process.env.OPENAI_API_KEY) {
    env.credentials = { ok: true, via: 'openai-api-key', source: 'OPENAI_API_KEY', provider, authFile: env.credentials.authFile };
  }

  if (!env.credentials.ok && !env.notes.some((n) => n.includes('cannot authenticate'))) {
    env.notes.push(
      'no Codex credential found. Use one of: `codex login` (writes auth.json), a provider in '
      + 'config.toml whose env_key is set, or OPENAI_API_KEY.',
    );
  }

  env.hasApiKey = env.credentials.ok;
  return env;
}

// ---------------------------------------------------------------------------
// codex exec runner
//
// 反向兼容的写法对照官方 openai/codex-plugin-cc（2026-10-19 重读其源码）：
//
//   (a) 【窄口径抑制】只在错误确实是"该特性不存在"时降级，认证/网络错误必须照抛。
//       官方 codex.mjs startThread():
//         // Only suppress "unknown variant/method" errors from older CLI versions
//         // that don't support thread/name/set. Rethrow auth, network, or server errors.
//         if (!msg.includes("unknown variant") && !msg.includes("unknown method")) throw err;
//
//   (b) 【必需特性缺失给可执行指引】官方 codex.mjs 在 rpcCode === -32601 时不静默：
//         "This Codex version does not support Claude session transfer.
//          Update Codex with `npm install -g @openai/codex@latest`, then retry."
//
//   本文件此前是【版本盲】的：硬用 --output-last-message，一旦本地 codex 不支持该 flag，
//   就把裸 stderr 丢给模型，模型只能看到 "exit code: 2"。现在改为先探测 `codex exec --help`
//   的 flag 面，再按能力构建参数；探测失败时保守地按完整面走（保持旧行为），
//   失败且错误确实是"不认识的参数"时降级重试一次，并在输出里写明降级了什么。
// ---------------------------------------------------------------------------

// 受保护参数：由本插件管理，不接受调用方通过 extraArgs 覆写。
// 注意这【不是】能力判据 —— 一个版本支持哪些 flag 由 probeExecCapabilities() 决定；
// 这份列表只回答"哪些参数不许用户自己传"。
const PROTECTED_ARGS = [
  '--cd', '--sandbox', '--permission-prompt', '--config', '--profile',
  '--json', '--output-last-message', '--output-json', '--full-trace',
  '--model', '--model-provider', '--reasoning-effort',
];

export function validateExtraArgs(extraArgs: string[] | undefined): void {
  const bad = (extraArgs ?? []).filter((a) => PROTECTED_ARGS.includes(a));
  if (bad.length > 0) {
    throw new Error(`refusing protected codex args: ${bad.join(', ')} (managed by dsh-codex)`);
  }
}

export interface ExecCapabilities {
  probed: boolean;
  outputLastMessage: boolean;
  json: boolean;
  reasoningEffort: boolean;
  skipGitRepoCheck: boolean;
  note: string | null;
}

let execCaps: ExecCapabilities | null = null;

/** 探测 `codex exec --help` 暴露的 flag 面。结果进程内缓存。 */
export function probeExecCapabilities(force = false): ExecCapabilities {
  if (execCaps && !force) return execCaps;
  const caps: ExecCapabilities = {
    probed: false, outputLastMessage: false, json: false,
    reasoningEffort: false, skipGitRepoCheck: false, note: null,
  };
  try {
    const help = execFileSync(CODEX_BIN, ['exec', '--help'], {
      encoding: 'utf8', shell: IS_WIN, timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const flags = new Set<string>();
    for (const m of help.matchAll(/(?:^|[\s,])(--[a-z0-9][a-z0-9-]*)/g)) flags.add(m[1]);
    caps.outputLastMessage = flags.has('--output-last-message');
    caps.json = flags.has('--json');
    caps.reasoningEffort = flags.has('--reasoning-effort');
    caps.skipGitRepoCheck = flags.has('--skip-git-repo-check');
    caps.probed = flags.size > 0;
    if (!caps.probed) caps.note = 'could not parse `codex exec --help`; assuming the full flag set';
  } catch (e) {
    caps.note = `could not probe \`codex exec --help\` (${(e as Error).message.slice(0, 120)}); assuming the full flag set`;
  }
  execCaps = caps;
  return caps;
}

/**
 * 窄口径判定：这段 stderr 是否在说"我不认识这个参数"。
 *
 * 只认这一种。认证失败、网络错误、超时、配置错误一律【不】算 —— 那是官方
 * "Rethrow auth, network, or server errors" 的同一原则：降级只能针对版本差异。
 */
export function isUnsupportedFlagError(text: string): boolean {
  return /(unknown (option|argument|flag)|unexpected argument|unrecognized argument|invalid option)/i.test(text);
}

interface ExecRun {
  code: number | null;
  message: string;
  stderr: string;
  timedOut: boolean;
}

function runExecOnce(args: string[], dir: string, prompt: string, timeoutMs: number): Promise<ExecRun> {
  return new Promise<ExecRun>((resolve) => {
    let stderr = '';
    let stdout = '';
    let timedOut = false;
    const child = spawn(CODEX_BIN, args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], shell: IS_WIN });
    const timer = setTimeout(() => {
      timedOut = true;
      if (IS_WIN) {
        // shell:true 时 child 是 cmd.exe;kill 只杀它,node 子进程变孤儿并持有
        // stderr 管道,close 永不触发。必须杀整棵进程树。
        try {
          spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
        } catch {
          /* taskkill unavailable; fall through */
        }
      } else {
        child.kill('SIGKILL');
      }
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => { stdout += String(d); });
    child.stderr.on('data', (d: Buffer) => { stderr += String(d); });
    child.on('error', (err: Error) => {
      clearTimeout(timer);
      resolve({ code: null, message: '', stderr: `failed to spawn codex: ${err.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, message: stdout, stderr, timedOut });
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

export async function runCodexExec(opts: ExecOptions): Promise<string> {
  const env = detectEnvironment();
  if (!env.hasCodexBin) {
    return `codex CLI not available.\n${env.notes.join('\n')}\n\nRun codex_status for full diagnostics, then install: npm install -g @openai/codex`;
  }
  if (!env.credentials.ok) {
    return [
      'Codex has no usable credential, so it cannot authenticate.',
      'Any ONE of these is enough:',
      '  1. `codex login`            (writes auth.json -- the ChatGPT-plan route)',
      '  2. set the env_key named by the active provider in config.toml',
      '  3. set OPENAI_API_KEY       (direct API-key route)',
      'Run codex_status for the detected provider and which path is missing.',
    ].join('\n');
  }

  validateExtraArgs(opts.extraArgs);

  const caps = probeExecCapabilities();
  const assumeFull = !caps.probed;              // 探测失败时保守地按完整面走（保持旧行为）
  const dir = opts.cwd ?? process.cwd();
  const tmp = await mkdtemp(join(tmpdir(), 'dsh-codex-'));
  const outFile = join(tmp, 'last-message.txt');
  await writeFile(join(tmp, 'prompt.txt'), opts.prompt, 'utf8');
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;

  const notes: string[] = [];
  if (caps.note) notes.push(caps.note);

  const useFileChannel = assumeFull || caps.outputLastMessage;
  const full: string[] = ['exec'];
  if (assumeFull || caps.skipGitRepoCheck) full.push('--skip-git-repo-check');
  full.push('--cd', dir);
  if (useFileChannel) full.push('--output-last-message', outFile);
  else {
    // 不静默降级：告诉调用方消息是从 stdout 拿的，为什么。
    notes.push('this Codex version has no --output-last-message flag; the final message was read from stdout instead.');
  }
  if (opts.model) full.push('--model', opts.model);
  if (opts.reasoningEffort) {
    if (assumeFull || caps.reasoningEffort) full.push('--reasoning-effort', opts.reasoningEffort);
    else {
      // 2026-10-19 实测：codex-cli 0.149.0 的 `exec --help` 里【没有】--reasoning-effort。
      // 静默丢掉用户的意图比报错更糟 —— 所以显式记一条。
      // 没有把它映射到 `-c model_reasoning_effort=…`，因为当前环境缺认证，
      // 无法实测该配置键是否被这个版本接受；不拿假设当修复。
      notes.push(
        `this Codex version (${env.codexVersion ?? 'unknown'}) has no --reasoning-effort flag; `
        + `the requested effort "${opts.reasoningEffort}" was dropped. Set it in codex config instead.`,
      );
    }
  }
  full.push(...(opts.extraArgs ?? []));

  let result = await runExecOnce(full, dir, opts.prompt, timeoutMs);
  let usedFile = useFileChannel;

  // 降级：仅当失败原因确实是"不认识的参数"，且我们确实多带了可选 flag。
  const optionalCount = full.length - (1 + (full.includes('--cd') ? 2 : 0));
  if (result.code !== 0 && !result.timedOut && optionalCount > 0 && isUnsupportedFlagError(result.stderr)) {
    const minimal: string[] = ['exec', '--cd', dir];
    if (opts.model) minimal.push('--model', opts.model);
    notes.push(
      'this Codex version rejected at least one flag we normally pass '
      + `(stderr said: ${result.stderr.trim().split('\n')[0].slice(0, 160)}). `
      + 'Retried with the minimal flag set. Update with `npm install -g @openai/codex@latest` to restore full behaviour.',
    );
    result = await runExecOnce(minimal, dir, opts.prompt, timeoutMs);
    usedFile = false;
  }

  let last = '';
  if (usedFile) {
    try { last = await readFile(outFile, 'utf8'); } catch { /* no output file */ }
  }
  await rm(tmp, { recursive: true, force: true }).catch(() => {});

  const lines: string[] = [];
  lines.push(`exit code: ${result.code}${result.timedOut ? ' (timed out, killed)' : ''}`);
  if (notes.length) lines.push('', '[compat]', ...notes);
  if (last.trim()) lines.push('', last.trim());
  else if (result.message.trim()) lines.push('', result.message.trim().slice(-4000));
  else if (result.stderr.trim()) lines.push('', '[stderr]', result.stderr.trim().slice(-2000));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// HTTP surface (native node handler -- no framework, no dependency)
// ---------------------------------------------------------------------------
//
// This used to be a Hono app. Two reasons it is not any more:
//   1. `hono` was a runtime dependency, and this plugin's installed copy had been deleted, so the
//      plugin could not be rebuilt from source at all ("Could not resolve hono").
//   2. The host's own HTTP surface is `ctx.webServer.register({kind, path, handler})`, where the
//      handler is a plain `(req: IncomingMessage, res: ServerResponse) => void` -- the same shape
//      the other plugins in this workspace already use. A framework's `fetch` signature has to be
//      adapted to that; a native handler does not.

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Just enough of the official HostConnectionService for the fence call. */
interface RequestFenceConnection {
  /** @returns 401/403 when the request must be refused, `undefined` when it may proceed. */
  requestRejection: (request: IncomingMessage) => number | undefined;
}

/**
 * Build the Host/Origin fence for one plugin life.
 *
 * Every route must ask the composition's `connection` service for a rejection first: its fence
 * defeats DNS rebinding and cross-site calls. `ctx.get` is the official read that does not require
 * declaring `inject`; `Reflect.get` and a bare property read both throw for an undeclared service.
 *
 * @returns true when the request was already answered and the handler must stop.
 */
export function createRequestFence(ctx: unknown): (req: IncomingMessage, res: ServerResponse) => boolean {
  const resolveConnection = (): RequestFenceConnection | undefined => {
    const read = (ctx as { get?: (name: string) => unknown } | null | undefined)?.get;
    if (typeof read !== 'function') return undefined;
    try {
      const connection = read.call(ctx, 'connection') as RequestFenceConnection | undefined;
      return typeof connection?.requestRejection === 'function' ? connection : undefined;
    } catch {
      return undefined;
    }
  };

  return (req, res) => {
    const connection = resolveConnection();
    if (connection === undefined) {
      // Fail closed: an unreachable fence must not become an open route.
      sendJson(res, 503, { error: 'connection service unavailable: the Host/Origin fence cannot be applied' });
      return true;
    }
    const rejection = connection.requestRejection(req);
    if (rejection === undefined) return false;
    res.statusCode = rejection;
    res.end();
    return true;
  };
}

const ROUTES: Record<string, () => unknown> = {
  '/api/codex/health': () => ({ ok: true, plugin: 'dsh-codex', ts: true, env: detectEnvironment().hasCodexBin }),
  '/api/codex/status': () => detectEnvironment(),
};

/**
 * The read-only status routes as a native node handler, fenced.
 *
 * The fence runs FIRST, before any route logic: an unfenced status route still leaks the local
 * Codex environment (paths, provider, which credentials are present) to any page that can reach
 * the port.
 */
export function handleHttp(req: IncomingMessage, res: ServerResponse): void {
  const path = (req.url ?? '').split('?')[0];
  const payload = ROUTES[path];
  if (payload === undefined) { sendJson(res, 404, { ok: false, error: 'not found' }); return; }
  if (req.method !== 'GET') { res.setHeader('allow', 'GET'); sendJson(res, 405, { ok: false, error: 'method not allowed' }); return; }
  sendJson(res, 200, payload());
}

/** Build the fenced handler bound to one plugin context. */
export function createHttpHandler(ctx: unknown): (req: IncomingMessage, res: ServerResponse) => void {
  const rejected = createRequestFence(ctx);
  return (req, res) => {
    if (rejected(req, res)) return;
    handleHttp(req, res);
  };
}

// ---------------------------------------------------------------------------
// tool registration
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function apply(ctx: any): void {
  ctx.tools.register(defineTool({
    name: 'codex_status',
    description: 'Detect the local Codex environment: binary on PATH, version, CODEX_HOME/config, active provider, and which credential path supplies authentication. Returns setup guidance when pieces are missing.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a: unknown, v: string) => [{ type: 'text', text: v }] },
    async execute() {
      const env = detectEnvironment();
      const c = env.credentials;
      const viaText: Record<typeof c.via, string> = {
        'openai-api-key': 'OPENAI_API_KEY env var',
        'provider-env-key': `env var ${c.source} (named by provider "${c.provider}" in config.toml)`,
        'oauth-auth-json': 'auth.json (from `codex login`)',
        none: 'NONE -- Codex cannot authenticate',
      };
      const lines = [
        '## Codex environment',
        `binary: ${env.hasCodexBin ? 'found' : 'NOT FOUND'}${env.codexVersion ? ` (${env.codexVersion})` : ''}`,
        `CODEX_HOME: ${env.codexHome ?? '(unset, default ~/.codex)'}`,
        `config: ${env.configFile ?? '(none)'}`,
        `provider: ${c.provider ?? '(default / not configured)'}`,
        `credentials: ${c.ok ? 'ok' : 'MISSING'} -- via ${viaText[c.via]}`,
        `auth.json: ${c.authFile ?? '(absent)'}`,
        `OPENAI_API_KEY: ${process.env.OPENAI_API_KEY ? 'set' : 'not set'} (only one of three possible paths)`,
      ];
      if (env.notes.length) lines.push('', '### action needed', ...env.notes.map((n) => `- ${n}`));
      lines.push(
        '',
        '### usage',
        '- codex_exec: run one Codex task in a workspace directory',
        '- review with Codex / security audit tools become available once the binary and a credential are present',
        '',
        '### configuring a non-OpenAI provider (e.g. DeepSeek)',
        'Codex talks to models through the Responses API, so the provider must implement it.',
        'DeepSeek supports it natively; OpenAI documents the exact config.toml + models.json shape:',
        '  https://api-docs.deepseek.com/quick_start/agent_integrations/codex',
        'Minimum for a custom provider: set `model_provider`, then in its section',
        '`[model_providers.<name>]` set base_url, env_key, and `wire_api = "responses"`.',
        'NOTE: `wire_api = "chat"` was REMOVED from Codex in Feb 2026 and is now a hard startup error.',
      );
      return lines.join('\n');
    },
  }));

  ctx.tools.register(defineTool({
    name: 'codex_exec',
    description: 'Run one Codex task (codex exec) in a directory: Codex plans, edits files, runs commands, and returns its final message. Requires the codex CLI on PATH and OPENAI_API_KEY (see codex_status). Use for delegating an implementation task to Codex when you want a second agent to work independently in a workspace.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Task description for Codex (what to implement / fix / analyze).' },
      cwd: { type: 'string', description: 'Working directory (default: current workspace).' },
      model: { type: 'string', description: 'Optional model override, e.g. codex-mini-latest.' },
      reasoningEffort: { type: 'string', description: 'Optional reasoning effort (minimal/low/medium/high).' },
      extraArgs: { type: 'array', items: { type: 'string' }, description: 'Optional safe extra args (protected args are rejected).' },
      timeoutMs: { type: 'number', description: 'Kill after this many ms (default 600000).' },
    },
    output: { schema: { type: 'string' }, render: (_a: unknown, v: string) => [{ type: 'text', text: v }] },
    async execute(args: ExecOptions) {
      if (!args.prompt || !String(args.prompt).trim()) throw new Error('prompt is required');
      return runCodexExec({ ...args, prompt: String(args.prompt) });
    },
  }));

  // Mount the fenced native handler on the host's HTTP surface. `ctx.inject` is required, not
  // optional sugar: reading a registered-but-undeclared service off `ctx` THROWS in cordis ("cannot
  // get property X without inject"), and an optional chain does not help -- the whole plugin fails
  // to activate. The previous `try { ctx.http?.mount(...) } catch {}` form was a no-op that only
  // LOOKED like a mount: `ctx.http` is not a host service.
  ctx.inject(['webServer'], (webCtx: any) => {
    webCtx.effect(() => {
      const dispose = webCtx.webServer.register({
        kind: 'prefix',
        path: '/api/codex',
        handler: createHttpHandler(ctx),
      });
      return () => { if (typeof dispose === 'function') dispose(); };
    });
  });
}
