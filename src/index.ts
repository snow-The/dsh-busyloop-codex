/**
 * dsh-codex — OpenAI Codex as a DSH ecosystem plugin (TypeScript + Hono).
 *
 * Tools:
 *   codex_status — environment detection (binary / CODEX_HOME / API key).
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
import { Hono } from 'hono';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { execFileSync } from 'node:child_process';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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
  hasApiKey: boolean;
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

function detectEnvironment(): CodexEnv {
  const env: CodexEnv = {
    hasCodexBin: false,
    codexVersion: null,
    codexHome: process.env.CODEX_HOME ?? null,
    hasApiKey: Boolean(process.env.OPENAI_API_KEY),
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
  const home = env.codexHome ?? homedir();
  if (home) {
    const cfg = join(home, '.codex', 'config.toml');
    if (existsSync(cfg)) env.configFile = cfg;
  }
  if (!env.hasApiKey) {
    env.notes.push('OPENAI_API_KEY not set. Codex needs an OpenAI API key (or a compatible provider).');
  }
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
  if (!env.hasApiKey) {
    return `OPENAI_API_KEY is not set. Codex cannot authenticate.\nSet OPENAI_API_KEY (or configure a compatible provider in ~/.codex/config.toml).`;
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
// Hono app (embedded fetch handler; env carries the cordis ctx)
// ---------------------------------------------------------------------------

export interface AppEnv {
  Bindings: { ctx: unknown };
}

export function createHonoApp(ctx: unknown): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get('/api/codex/status', (c) => c.json(detectEnvironment()));
  app.get('/api/codex/health', (c) =>
    c.json({ ok: true, plugin: 'dsh-codex', ts: true, hono: true, env: detectEnvironment().hasCodexBin })
  );
  void ctx;
  return app;
}

// ---------------------------------------------------------------------------
// tool registration
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function apply(ctx: any): void {
  ctx.tools.register(defineTool({
    name: 'codex_status',
    description: 'Detect the local Codex environment: binary on PATH, version, CODEX_HOME/config, OPENAI_API_KEY. Returns setup guidance when pieces are missing.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a: unknown, v: string) => [{ type: 'text', text: v }] },
    async execute() {
      const env = detectEnvironment();
      const lines = [
        '## Codex environment',
        `binary: ${env.hasCodexBin ? 'found' : 'NOT FOUND'}${env.codexVersion ? ` (${env.codexVersion})` : ''}`,
        `CODEX_HOME: ${env.codexHome ?? '(unset, default ~/.codex)'}`,
        `config: ${env.configFile ?? '(none)'}`,
        `OPENAI_API_KEY: ${env.hasApiKey ? 'set' : 'NOT SET'}`,
      ];
      if (env.notes.length) lines.push('', '### action needed', ...env.notes.map((n) => `- ${n}`));
      lines.push('', '### usage', '- codex_exec: run one Codex task in a workspace directory', '- review with Codex / security audit tools become available once binary + key are present');
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

  // Optional: mount the Hono app if the host exposes an http service.
  try {
    const http = ctx.http;
    if (http?.mount) {
      http.mount('/codex', createHonoApp(ctx).fetch);
    }
  } catch {
    /* host has no http mount point; app remains exported for manual mounting */
  }
}
