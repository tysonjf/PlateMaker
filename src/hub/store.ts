import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../config.ts';
import type { SensorKind } from '../devices/types.ts';

export type ChannelRole = 'meat' | 'pit' | 'off';

export interface ChannelInfo {
  /** Short stable id, e.g. "A1" (device letter + sensor number). */
  id: string;
  deviceId: string;
  index: number;
  kind: SensorKind;
  /** Physical sensor name from the device driver, e.g. "Black probe". */
  name?: string;
}

export interface ChannelSettings {
  label?: string;
  role?: ChannelRole;
  /** Meat: temperature at which to pull (°C). */
  targetC?: number;
  /** Pit: acceptable range (°C). */
  lowC?: number;
  highC?: number;
}

export interface CookMeta {
  id: string;
  name: string;
  meat?: string;
  weightKg?: number;
  method?: string;
  /** Free text: "serve at 6pm", "slice for sandwiches"… */
  goal?: string;
  /** Epoch ms the user wants to eat, if known. */
  serveAt?: number;
  createdAt: number;
  /** When the meat went on (null until a cook is started). */
  startedAt: number | null;
  endedAt: number | null;
  channels: Record<string, ChannelInfo>;
  settings: Record<string, ChannelSettings>;
}

export type EventType = 'note' | 'alarm' | 'alarm-cleared' | 'system' | 'claude';
export type Severity = 'info' | 'warning' | 'critical';

export interface CookEvent {
  id: number;
  at: number;
  type: EventType;
  severity: Severity;
  /** Machine code for alarms, e.g. "pit_low". */
  code?: string;
  channelId?: string;
  title: string;
  message?: string;
  source: 'hub' | 'user' | 'claude';
  /** Machine reference time for one-off events (stall start, dip bottom) used for de-duplication. */
  ref?: number;
}

export interface SampleRow {
  t: number;
  v: Record<string, number | null>;
}

const RESUME_WINDOW_MS = 8 * 3600_000;

function newCookId(now: number): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `${stamp}_${Math.random().toString(36).slice(2, 6)}`;
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a torn last line after a crash — skip it
    }
  }
  return out;
}

export class CookStore {
  readonly dir: string;
  meta: CookMeta;
  samples: SampleRow[];
  events: CookEvent[];

  private constructor(dir: string, meta: CookMeta, samples: SampleRow[], events: CookEvent[]) {
    this.dir = dir;
    this.meta = meta;
    this.samples = samples;
    this.events = events;
  }

  static cooksDir(dataDir: string): string {
    return join(dataDir, 'cooks');
  }

  /** Resume the most recent unfinished cook if it was active recently, otherwise start a fresh log. */
  static openOrCreate(dataDir: string, now = Date.now()): { store: CookStore; resumed: boolean } {
    const latest = CookStore.latest(dataDir);
    if (latest && latest.meta.endedAt == null) {
      const last = latest.samples.at(-1)?.t ?? latest.meta.createdAt;
      if (now - last < RESUME_WINDOW_MS) return { store: latest, resumed: true };
    }
    return { store: CookStore.create(dataDir, now), resumed: false };
  }

  static create(dataDir: string, now = Date.now(), carryChannels?: Record<string, ChannelInfo>): CookStore {
    const id = newCookId(now);
    const dir = join(CookStore.cooksDir(dataDir), id);
    mkdirSync(dir, { recursive: true });
    const meta: CookMeta = {
      id,
      name: 'Untitled cook',
      createdAt: now,
      startedAt: null,
      endedAt: null,
      channels: { ...(carryChannels ?? {}) },
      settings: {},
    };
    const store = new CookStore(dir, meta, [], []);
    store.saveMeta();
    return store;
  }

  static load(dir: string): CookStore | null {
    const metaPath = join(dir, 'cook.json');
    if (!existsSync(metaPath)) return null;
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as CookMeta;
      meta.channels ??= {};
      meta.settings ??= {};
      const samples = readJsonl<SampleRow>(join(dir, 'samples.jsonl'));
      const events = readJsonl<CookEvent>(join(dir, 'events.jsonl'));
      return new CookStore(dir, meta, samples, events);
    } catch {
      return null;
    }
  }

  static list(dataDir: string): string[] {
    const root = CookStore.cooksDir(dataDir);
    if (!existsSync(root)) return [];
    return readdirSync(root)
      .map((name) => join(root, name))
      .filter((p) => existsSync(join(p, 'cook.json')))
      .sort((a, b) => statSync(join(a, 'cook.json')).mtimeMs - statSync(join(b, 'cook.json')).mtimeMs);
  }

  static latest(dataDir: string): CookStore | null {
    const dirs = CookStore.list(dataDir);
    for (let i = dirs.length - 1; i >= 0; i--) {
      const s = CookStore.load(dirs[i]);
      if (s) return s;
    }
    return null;
  }

  saveMeta(): void {
    writeJsonAtomic(join(this.dir, 'cook.json'), this.meta);
  }

  appendSample(row: SampleRow): void {
    this.appendSamples([row]);
  }

  appendSamples(rows: SampleRow[]): void {
    if (!rows.length) return;
    for (const r of rows) this.samples.push(r);
    appendFileSync(join(this.dir, 'samples.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }

  addEvent(e: Omit<CookEvent, 'id'>): CookEvent {
    const event: CookEvent = { id: (this.events.at(-1)?.id ?? 0) + 1, ...e };
    this.events.push(event);
    appendFileSync(join(this.dir, 'events.jsonl'), JSON.stringify(event) + '\n');
    return event;
  }

  registerChannel(info: ChannelInfo): boolean {
    const existing = this.meta.channels[info.id];
    if (existing && existing.deviceId === info.deviceId && existing.kind === info.kind && existing.name === info.name) return false;
    this.meta.channels[info.id] = info;
    this.saveMeta();
    return true;
  }
}
