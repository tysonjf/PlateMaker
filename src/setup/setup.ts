// `pnpm configure`: units, optional phone push, Claude Desktop MCP entry, skill zip for upload.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { configPath, loadConfig, saveConfig, writeJsonAtomic } from '../config.ts';
import { zip, type ZipEntry } from './zip.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function desktopConfigPath(): string | null {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'win32' && process.env.APPDATA) return join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json');
  return null;
}

/** Add/replace the smoke-signal server in Claude Desktop's config (backing the file up first). */
export function installDesktopServer(path: string): { backup: string | null } {
  let cfg: { mcpServers?: Record<string, unknown> } = {};
  let backup: string | null = null;
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8');
    try {
      cfg = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      throw new Error(`${path} isn't valid JSON — fix or remove it, then run setup again.`);
    }
    backup = `${path}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(path, backup);
  } else {
    mkdirSync(dirname(path), { recursive: true });
  }
  cfg.mcpServers = {
    ...(cfg.mcpServers ?? {}),
    'smoke-signal': {
      command: process.execPath,
      args: [join(root, 'bin', 'smoke-signal.mjs'), 'mcp'],
    },
  };
  writeJsonAtomic(path, cfg);
  return { backup };
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Package the pitmaster skill for upload to Claude Desktop / claude.ai (Claude-Code-only keys stripped). */
export function buildSkillZip(): string {
  const skillDir = join(root, '.claude', 'skills', 'pitmaster');
  const entries: ZipEntry[] = walk(skillDir).map((file) => {
    let data = readFileSync(file);
    if (file.endsWith('SKILL.md')) {
      const text = data
        .toString('utf8')
        .replace(/^argument-hint:.*\n/m, '')
        .replace(/^allowed-tools:.*\n/m, '');
      data = Buffer.from(text, 'utf8');
    }
    return { name: `pitmaster/${relative(skillDir, file).split('\\').join('/')}`, data };
  });
  const out = join(root, 'dist', 'pitmaster-skill.zip');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, zip(entries));
  return out;
}

export async function runSetup(_args: string[]): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(3).filter((a) => a !== '--'),
    strict: false,
    options: {
      unit: { type: 'string' },
      ntfy: { type: 'string' },
      desktop: { type: 'boolean' },
      'no-desktop': { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
    },
  });
  const interactive = process.stdin.isTTY && !values.yes;
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const ask = async (q: string, def: string) => {
    if (!rl) return def;
    const a = (await rl.question(`${q} `)).trim();
    return a || def;
  };

  console.log('🔥 Smoke Signal configuration\n');
  const cfg = loadConfig();

  // 1. Units
  let unit = typeof values.unit === 'string' ? values.unit.toUpperCase() : '';
  if (unit !== 'F' && unit !== 'C') unit = (await ask(`Temperature unit — F or C? [${cfg.unit}]`, cfg.unit)).toUpperCase();
  if (unit === 'F' || unit === 'C') cfg.unit = unit;

  // 2. Phone push for the hub's own alarms (works even when no Claude session is running)
  let topic = typeof values.ntfy === 'string' ? values.ntfy : undefined;
  if (topic === undefined && interactive) {
    const want = await ask(
      `Push hub alarms to your phone with the free ntfy app, even if Claude isn't running? ${cfg.ntfy.topic ? `(currently: ${cfg.ntfy.topic}) ` : ''}[y/N]`,
      'n',
    );
    if (/^y/i.test(want)) topic = cfg.ntfy.topic || 'random';
  }
  if (topic === 'off') cfg.ntfy.topic = '';
  else if (topic) cfg.ntfy.topic = topic === 'random' ? `smoke-signal-${randomBytes(6).toString('hex')}` : topic;
  saveConfig(cfg);
  console.log(`\n✔ Saved ${configPath()} (unit °${cfg.unit}${cfg.ntfy.topic ? `, ntfy topic ${cfg.ntfy.topic}` : ''})`);
  if (cfg.ntfy.topic) {
    console.log(
      `  → Install "ntfy" on your phone (App Store / Play Store), tap +, and subscribe to topic: ${cfg.ntfy.topic}\n` +
        '    Treat the topic like a password — anyone who knows it can read your alerts.',
    );
    try {
      await fetch(cfg.ntfy.server, {
        method: 'POST',
        body: JSON.stringify({ topic: cfg.ntfy.topic, title: 'Smoke Signal connected', message: 'Hub alarms will show up here.', tags: ['fire'] }),
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      console.log('    Sent a test notification.');
    } catch {
      console.log("    (Couldn't send a test notification right now — check your internet connection.)");
    }
  }

  // 3. Claude Desktop
  const desktopPath = desktopConfigPath();
  if (desktopPath && !values['no-desktop']) {
    const hasDesktop = existsSync(dirname(desktopPath));
    const doIt =
      values.desktop === true ||
      (hasDesktop && /^y/i.test(await ask('Add Smoke Signal to the Claude desktop app (chat & Cowork)? [Y/n]', 'y')));
    if (doIt) {
      const { backup } = installDesktopServer(desktopPath);
      console.log(`\n✔ Added "smoke-signal" to ${desktopPath}${backup ? `\n  (backup: ${backup})` : ''}\n  → Quit and reopen the Claude desktop app to load it.`);
    } else if (!hasDesktop) {
      console.log('\n• Claude desktop app not found — skipping (run `pnpm configure --desktop` later if you install it).');
    }
  }

  // 4. Skill zip for Claude Desktop / claude.ai
  const zipPath = buildSkillZip();
  console.log(
    `\n✔ Packaged the pitmaster skill: ${zipPath}\n` +
      '  → Optional, for the Claude desktop/web app: Settings → Capabilities → Skills → upload this zip.\n' +
      '    (Claude Code picks the skill up automatically from this folder.)',
  );

  rl?.close();

  console.log(`
Next steps
  1. Start the hub in its own Terminal window (keep it running):   pnpm start
     First run: macOS asks to allow Bluetooth for your terminal — say Allow.
     Close the INKBIRD phone app first; the base only accepts one Bluetooth connection.
  2. Start Claude Code in this folder with phone access:            claude --rc
     Approve the "smoke-signal" MCP server if asked, then run:      /pitmaster start <what you're cooking>
  3. On your phone, open the session in the Claude app. In Claude Code, /config → "Push when Claude decides".
  Dashboard: http://localhost:${cfg.port}   ·   Try it all without hardware: pnpm demo
`);
}
