/**
 * dsh-codex — OpenAI Codex as a DSH ecosystem plugin.
 *
 * Tools:
 *   codex_status — environment detection (codex binary, CODEX_HOME, API key,
 *                  version); guides the user through setup when missing.
 *   codex_exec   — run one Codex task: spawn `codex exec`, prompt via stdin,
 *                  result read back through --output-last-message file channel
 *                  (pattern absorbed from openai/codex-action research).
 *
 * Design notes (from codex-zone research):
 *   - CLI spawn, not SDK: codex-action spawns `codex exec` with prompt on
 *     stdin and collects the final message from a file. Same contract here.
 *   - Auth/execution separation: never pass keys on argv; keep environment
 *     based (OPENAI_API_KEY / CODEX_HOME) like upstream.
 *   - Parameter validation before spawn (restricted-arg list).
 *
 * Core is node builtins + official DSH services only.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

export const name = 'dsh-codex';

export const inject = ['tools'];

// ---------------------------------------------------------------------------
// environment detection
// ---------------------------------------------------------------------------

function findCodexBin() {
  const candidates = ['codex', 'codex.exe'];
  for (const c of candidates) {
    try {
      // eslint-disable-next-line no-undef
      const r = spawnSyncSafe(c, ['--version']);
      if (r?.ok) return { bin: c, version: r.version };
    } catch { /* keep looking */ }
  }
  return null;
}

function spawnSyncSafe(bin, args) {
  // manual sync spawn without child_process.spawnSync to stay test-friendly
  const { execFileSync } = require('node:child_process');
  try {
    const out = execFileSync(bin, args, { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, version: out.split('\n')[0]?.trim() ?? '' };
  } catch {
    return { ok: false };
  }
}

function detectEnvironment() {
  const env = {
    hasCodexBin: false,
    codexVersion: null,
    codexHome: process.env.CODEX_HOME ?? null,
    hasApiKey: Boolean(process.env.OPENAI_API_KEY),
    configFile: null,
    notes: [],
  };
  const bin = findCodexBin();
  if (bin) {
    env.hasCodexBin = true;
    env.codexVersion = bin.version;
  } else {
    env.notes.push('codex binary not found on PATH. Install with: npm install -g @openai/codex');
  }
  const home = env.codexHome ?? (process.env.USERPROFILE || process.env.HOME);
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

function validateExtraArgs(extraArgs) {
  const bad = (extraArgs ?? []).filter((a) => PROTECTED_ARGS.includes(a));
  if (bad.length > 0) {
    throw new Error(`refusing protected codex args: ${bad.join(', ')} (managed by dsh-codex)`);
  }
}

/**
 * Run `codex exec` once.
 * @param {object} opts
 * @param {string} opts.prompt        task description (goes to stdin)
 * @param {string} [opts.cwd]         working directory (default process.cwd())
 * @param {string} [opts.model]       model override (e.g. codex-mini-latest)
 * @param {string} [opts.reasoningEffort] reasoning effort
 * @param {string[]} [opts.extraArgs] additional safe args (validated)
 * @param {number}  [opts.timeoutMs]  kill after timeout (default 10 min)
 */
async function runCodexExec(opts) {
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
  const promptFile = join(tmp, 'prompt.txt');
  await writeFile(promptFile, opts.prompt ?? '', 'utf8');

  const args = [
    'exec',
    '--skip-git-repo-check',
    '--cd', dir,
    '--output-last-message', outFile,
  ];
  if (opts.model) args.push('--model', opts.model);
  if (opts.reasoningEffort) args.push('--reasoning-effort', opts.reasoningEffort);
  args.push(...(opts.extraArgs ?? []));

  return new Promise((resolve) => {
    let stderr = '';
    let timedOut = false;
    const child = spawn('codex', args, { cwd: dir, stdio: ['pipe', 'ignore', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs ?? 10 * 60 * 1000);

    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve(`failed to spawn codex: ${err.message}`);
    });
    child.on('close', async (code) => {
      clearTimeout(timer);
      let last = '';
      try { last = await readFile(outFile, 'utf8'); } catch { /* no output file */ }
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
      const lines = [];
      lines.push(`exit code: ${code}${timedOut ? ' (timed out, killed)' : ''}`);
      if (last.trim()) lines.push('', last.trim());
      if (stderr.trim() && !last.trim()) lines.push('', '[stderr]', stderr.trim().slice(-2000));
      resolve(lines.join('\n'));
    });

    // prompt via stdin (auth/execution separation, upstream pattern)
    child.stdin.write(opts.prompt ?? '');
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// tool registration
// ---------------------------------------------------------------------------

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'codex_status',
    description: 'Detect the local Codex environment: binary on PATH, version, CODEX_HOME/config, OPENAI_API_KEY. Returns setup guidance when pieces are missing.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
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
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      if (!args.prompt || !String(args.prompt).trim()) throw new Error('prompt is required');
      return runCodexExec({
        prompt: String(args.prompt),
        cwd: args.cwd,
        model: args.model,
        reasoningEffort: args.reasoningEffort,
        extraArgs: args.extraArgs,
        timeoutMs: args.timeoutMs,
      });
    },
  }));
}
