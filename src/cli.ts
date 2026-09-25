#!/usr/bin/env node
// Smoke Signal command line: `node src/cli.ts <command>` (see `pnpm run` for shortcuts).

import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { dataDir, hubUrl, loadConfig, type Config } from './config.ts';

const HELP = `Smoke Signal — Bluetooth BBQ thermometer hub for Claude

Usage: pnpm <script> [options]   or   node bin/smoke-signal.mjs <command> [options]

Commands
  hub (pnpm start)     Connect to thermometers, record the cook, serve the dashboard + API
    --sim              Use the built-in smoker simulator instead of Bluetooth
    --speed N          Simulator time multiplier (e.g. 60 = one cook-hour per minute)
    --start-hours H    Simulator: start H hours into a cook (history is pre-filled)
    --port N           HTTP port (default 7474)
    --lan              Also serve the dashboard (read-only) to phones on your Wi-Fi
    --unit F|C         Display unit (saved in ~/.smoke-signal/config.json via setup)
    --open             Open the dashboard in your browser
    --verbose          Show Bluetooth protocol debug lines
  scan (pnpm scan)     List nearby Bluetooth devices and which ones are supported
    --seconds N  --all
  explore [name|id]    Connect to one device and dump everything (troubleshooting)
    --seconds N  --no-auth
  status (pnpm status) Print the current cook report from a running hub
  mcp                  Run the MCP server Claude uses (stdio; normally started by Claude)
    --channel          Also push alarms into the Claude Code session (research-preview channels)
  configure            Units, phone alerts, Claude desktop app integration, skill zip
  (pnpm configure)
`;

// pnpm forwards a literal "--" (`pnpm start -- --lan`); drop it so options after it still parse.
const argv = process.argv.slice(2).filter((a) => a !== '--');

const { positionals, values } = parseArgs({
  args: argv,
  allowPositionals: true,
  strict: false,
  options: {
    sim: { type: 'boolean' },
    speed: { type: 'string' },
    'start-hours': { type: 'string' },
    port: { type: 'string' },
    lan: { type: 'boolean' },
    unit: { type: 'string' },
    open: { type: 'boolean' },
    verbose: { type: 'boolean' },
    seconds: { type: 'string' },
    all: { type: 'boolean' },
    'no-auth': { type: 'boolean' },
    channel: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

const [command = 'hub', ...rest] = positionals;
const num = (v: unknown, d: number) => (typeof v === 'string' && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i!.address);
}

async function alreadyRunning(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/status`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function runHub(): Promise<void> {
  const { Hub, acceleratedClock, realClock } = await import('./hub/hub.ts');
  const { startServer } = await import('./hub/server.ts');
  const { TerminalUI } = await import('./hub/terminal.ts');

  let cfg: Config = loadConfig();
  if (values.unit === 'C' || values.unit === 'F') cfg.unit = values.unit;
  if (values.port) cfg.port = num(values.port, cfg.port);
  if (values.lan) cfg.host = '0.0.0.0';

  const url = `http://localhost:${cfg.port}`;
  if (await alreadyRunning(`http://127.0.0.1:${cfg.port}`)) {
    console.error(`A Smoke Signal hub is already running at ${url}. Stop it first (Ctrl+C in its terminal) or use --port.`);
    process.exit(1);
  }

  let hub: InstanceType<typeof Hub>;
  if (values.sim) {
    const { SimSource } = await import('./devices/sim.ts');
    const speed = Math.max(1, num(values.speed, 1));
    const clock = speed > 1 ? acceleratedClock(speed) : realClock;
    cfg = { ...structuredClone(cfg), devices: {}, onlyDevices: [] };
    const source = new SimSource(clock, { startHours: num(values['start-hours'], 0) });
    hub = new Hub({ cfg, source, clock, dataDir: join(dataDir(), 'sim'), freshCook: true });
  } else {
    const { BleSource } = await import('./devices/ble.ts');
    hub = new Hub({ cfg, source: new BleSource(cfg), dataDir: dataDir() });
  }

  const ui = new TerminalUI(hub, url, !!values.verbose);
  ui.attach();
  const server = await startServer(hub, { host: cfg.host, port: cfg.port }).catch((err: Error) => {
    console.error(`Could not start the web server on port ${cfg.port}: ${err.message}`);
    process.exit(1);
  });
  ui.print(`Dashboard: ${url}${cfg.host === '0.0.0.0' ? `  (phones on your Wi-Fi: ${lanAddresses().map((a) => `http://${a}:${cfg.port}`).join(', ')})` : ''}`);
  ui.print('Claude: open Claude Code in this folder and run /pitmaster (see README). Ctrl+C to stop.');

  try {
    await hub.start();
  } catch (err) {
    ui.stop();
    console.error(`\n${(err as Error).message}`);
    server.close();
    process.exit(1);
  }

  if (process.platform === 'darwin' && cfg.keepAwake && !values.sim) {
    // Stop the Mac idle-sleeping (which would pause Bluetooth and Claude) while the hub runs.
    spawn('caffeinate', ['-i', '-s', '-w', String(process.pid)], { stdio: 'ignore' }).on('error', () => {});
    ui.print('Keeping this Mac awake while the hub runs (plug it in; closing the lid will still sleep it).');
  }
  if (values.open) spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore' }).on('error', () => {});

  let stopping = false;
  const shutdown = async () => {
    if (stopping) process.exit(1);
    stopping = true;
    ui.stop();
    console.log('Stopping… (the cook log is saved; starting again resumes it)');
    server.close();
    await Promise.race([hub.stop(), new Promise((r) => setTimeout(r, 3000))]);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function runStatus(): Promise<void> {
  const url = hubUrl();
  try {
    const res = await fetch(`${url}/api/report`, { signal: AbortSignal.timeout(3000) });
    console.log(await res.text());
  } catch {
    console.error(`No hub running at ${url}. Start it with \`pnpm start\` (or \`pnpm sim\` to try the simulator).`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  if (values.help || command === 'help') {
    console.log(HELP);
    return;
  }
  switch (command) {
    case 'hub':
      return runHub();
    case 'scan': {
      const { scan } = await import('./devices/tools.ts');
      return scan(num(values.seconds, 15), !!values.all);
    }
    case 'explore': {
      const { explore } = await import('./devices/tools.ts');
      return explore(rest[0], num(values.seconds, 90), !values['no-auth']);
    }
    case 'status':
      return runStatus();
    case 'mcp': {
      const { runMcpServer } = await import('./mcp/server.ts');
      return runMcpServer({ channel: !!values.channel || process.env.SMOKE_SIGNAL_CHANNEL === '1' });
    }
    case 'configure':
    case 'setup': {
      const { runSetup } = await import('./setup/setup.ts');
      return runSetup(rest);
    }
    default:
      console.error(`Unknown command "${command}".\n`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
