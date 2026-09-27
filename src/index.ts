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
// codex exec runner (absorbed from codex-action: runCodexExec)
// ---------------------------------------------------------------------------

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

  const dir = opts.cwd ?? process.cwd();
  const tmp = await mkdtemp(join(tmpdir(), 'dsh-codex-'));
  const outFile = join(tmp, 'last-message.txt');
  await writeFile(join(tmp, 'prompt.txt'), opts.prompt, 'utf8');

  const args = ['exec', '--skip-git-repo-check', '--cd', dir, '--output-last-message', outFile];
  if (opts.model) args.push('--model', opts.model);
  if (opts.reasoningEffort) args.push('--reasoning-effort', opts.reasoningEffort);
  args.push(...(opts.extraArgs ?? []));

  return new Promise<string>((resolve) => {
    let stderr = '';
    let timedOut = false;
    const child = spawn(CODEX_BIN, args, { cwd: dir, stdio: ['pipe', 'ignore', 'pipe'], shell: IS_WIN });
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
    }, opts.timeoutMs ?? 10 * 60 * 1000);

    child.stderr.on('data', (d: Buffer) => { stderr += String(d); });
    child.on('error', (err: Error) => {
      clearTimeout(timer);
      resolve(`failed to spawn codex: ${err.message}`);
    });
    child.on('close', async (code) => {
      clearTimeout(timer);
      let last = '';
      try { last = await readFile(outFile, 'utf8'); } catch { /* no output file */ }
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
      const lines: string[] = [];
      lines.push(`exit code: ${code}${timedOut ? ' (timed out, killed)' : ''}`);
      if (last.trim()) lines.push('', last.trim());
      if (stderr.trim() && !last.trim()) lines.push('', '[stderr]', stderr.trim().slice(-2000));
      resolve(lines.join('\n'));
    });

    child.stdin.write(opts.prompt);
    child.stdin.end();
  });
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
