import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Unit } from './units.ts';

export interface DevicePrefs {
  /** Channel prefix assigned on first sight (A, B, …): sensors become A1, B1, B2… */
  letter?: string;
  /** Friendly name shown everywhere instead of the Bluetooth name, e.g. "Probe 1". */
  alias?: string;
  /** Never connect to this device. */
  ignore?: boolean;
}

export interface Config {
  unit: Unit;
  port: number;
  /** 127.0.0.1 (default) or 0.0.0.0 to let phones on your Wi-Fi open the dashboard (read-only). */
  host: string;
  /** How often a row of temperatures is recorded. */
  sampleSeconds: number;
  /** Optional phone push via https://ntfy.sh (free app). Leave topic empty to disable. */
  ntfy: { server: string; topic: string };
  /** Speak critical alarms out loud with macOS `say`. */
  speak: boolean;
  /** Show macOS notification banners for alarms. */
  desktopNotifications: boolean;
  /** Keep the Mac awake while the hub runs (macOS `caffeinate`). */
  keepAwake: boolean;
  /** If non-empty, only connect to these device ids (see `pnpm scan`). */
  onlyDevices: string[];
  devices: Record<string, DevicePrefs>;
}

export const DEFAULT_CONFIG: Config = {
  unit: 'F',
  port: 7474,
  host: '127.0.0.1',
  sampleSeconds: 5,
  ntfy: { server: 'https://ntfy.sh', topic: '' },
  speak: false,
  desktopNotifications: true,
  keepAwake: true,
  onlyDevices: [],
  devices: {},
};

export function dataDir(): string {
  return process.env.SMOKE_SIGNAL_HOME || join(homedir(), '.smoke-signal');
}

export function configPath(): string {
  return join(dataDir(), 'config.json');
}

export function loadConfig(): Config {
  const path = configPath();
  let fromDisk: Partial<Config> = {};
  if (existsSync(path)) {
    try {
      fromDisk = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      console.error(`[smoke-signal] Ignoring unreadable ${path}: ${(err as Error).message}`);
    }
  }
  const cfg: Config = {
    ...DEFAULT_CONFIG,
    ...fromDisk,
    ntfy: { ...DEFAULT_CONFIG.ntfy, ...(fromDisk.ntfy ?? {}) },
    devices: { ...(fromDisk.devices ?? {}) },
    onlyDevices: fromDisk.onlyDevices ?? [],
  };
  if (process.env.SMOKE_SIGNAL_UNIT === 'C' || process.env.SMOKE_SIGNAL_UNIT === 'F') {
    cfg.unit = process.env.SMOKE_SIGNAL_UNIT;
  }
  if (process.env.SMOKE_SIGNAL_NTFY_TOPIC) cfg.ntfy.topic = process.env.SMOKE_SIGNAL_NTFY_TOPIC;
  return cfg;
}

export function saveConfig(cfg: Config): void {
  mkdirSync(dataDir(), { recursive: true });
  writeJsonAtomic(configPath(), cfg);
}

export function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, path);
}

/** Where the hub listens, as seen by local clients (MCP server, `pnpm status`). */
export function hubUrl(cfg: Config = loadConfig()): string {
  return process.env.SMOKE_SIGNAL_URL || `http://127.0.0.1:${cfg.port}`;
}
