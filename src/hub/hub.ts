import { EventEmitter } from 'node:events';
import { saveConfig, type Config } from '../config.ts';
import type { DeviceSource, DeviceStatus, SensorStatus, SensorValue, SourceSink } from '../devices/types.ts';
import { AlarmEngine, type RaisedAlarm } from './alarms.ts';
import { analyzeAll, type ChannelAnalysis } from './analytics.ts';
import { Notifier } from './notify.ts';
import {
  CookStore,
  type ChannelInfo,
  type ChannelSettings,
  type CookEvent,
  type CookMeta,
  type SampleRow,
  type Severity,
} from './store.ts';

export interface Clock {
  now(): number;
  speed: number;
}

export const realClock: Clock = { now: () => Date.now(), speed: 1 };

export function acceleratedClock(speed: number, start = Date.now()): Clock {
  const realStart = Date.now();
  return { now: () => start + (Date.now() - realStart) * speed, speed };
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface DeviceView extends DeviceStatus {
  letter: string;
  alias: string;
}

export interface HubSnapshot {
  now: number;
  unit: Config['unit'];
  mode: DeviceSource['kind'];
  speed: number;
  cook: CookMeta;
  analyses: ChannelAnalysis[];
  devices: DeviceView[];
  activeAlarms: CookEvent[];
  recentEvents: CookEvent[];
  claudeLastCheckAt: number | null;
}

export interface CookUpdate {
  name?: string;
  meat?: string;
  weightKg?: number;
  method?: string;
  goal?: string;
  /** Epoch ms, or null to clear. */
  serveAt?: number | null;
  /** Per-channel settings to merge (null value clears a field). */
  channels?: Record<string, { label?: string | null; role?: ChannelSettings['role']; targetC?: number | null; lowC?: number | null; highC?: number | null }>;
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export class Hub extends EventEmitter implements SourceSink {
  readonly cfg: Config;
  readonly clock: Clock;
  readonly dataDir: string;
  store!: CookStore;
  private source: DeviceSource;
  private devices = new Map<string, DeviceStatus>();
  private latest = new Map<string, { v: number | null; at: number }>();
  private sensorStatus = new Map<string, SensorStatus>();
  private alarms = new AlarmEngine();
  private notifier: Notifier;
  private timer: NodeJS.Timeout | null = null;
  private lastAnalyses: ChannelAnalysis[] = [];
  private claudeLastCheckAt: number | null = null;
  private claudeChecks: number[] = [];

  private freshCook: boolean;

  constructor(opts: { cfg: Config; source: DeviceSource; clock?: Clock; dataDir: string; freshCook?: boolean }) {
    super();
    this.cfg = opts.cfg;
    this.source = opts.source;
    this.clock = opts.clock ?? realClock;
    this.dataDir = opts.dataDir;
    this.freshCook = opts.freshCook ?? false;
    this.notifier = new Notifier(this.cfg, (l, m) => this.log(l, m));
  }

  get mode(): DeviceSource['kind'] {
    return this.source.kind;
  }

  async start(): Promise<void> {
    const { store, resumed } = this.freshCook
      ? { store: CookStore.create(this.dataDir, this.clock.now()), resumed: false }
      : CookStore.openOrCreate(this.dataDir, this.clock.now());
    this.store = store;
    this.alarms.restore(store.events);
    if (resumed) {
      this.log('info', `Resumed cook "${store.meta.name}" (${store.samples.length} samples) from ${store.dir}`);
      this.addEvent({ type: 'system', severity: 'info', title: 'Hub restarted — resumed cook log', source: 'hub' });
    } else {
      this.log('info', `Recording to ${store.dir}`);
    }
    if (this.source.backfill && !resumed) this.ingestBackfill();
    await this.source.start(this);
    const periodMs = (this.cfg.sampleSeconds * 1000) / this.clock.speed;
    this.timer = setInterval(() => this.tick(), Math.max(50, periodMs));
  }

  /** Simulator: preload the virtual cook's history so charts and trends are populated immediately. */
  private ingestBackfill(): void {
    const rows: SampleRow[] = [];
    for (const { t, values } of this.source.backfill!(this.cfg.sampleSeconds * 1000)) {
      for (const [deviceId, vals] of values) this.sensors(deviceId, vals, t);
      const v: Record<string, number | null> = {};
      for (const [id, l] of this.latest) v[id] = l.v;
      rows.push({ t, v });
    }
    this.store.appendSamples(rows);
    if (rows.length && this.source.cookStart != null && this.store.meta.startedAt == null) {
      this.store.meta.startedAt = this.source.cookStart;
      this.store.saveMeta();
    }
    if (rows.length) this.log('info', `Simulator backfilled ${rows.length} samples.`);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.source.stop();
  }

  // ---- SourceSink ----------------------------------------------------------------------

  device(status: DeviceStatus): void {
    const prev = this.devices.get(status.id);
    this.devices.set(status.id, status);
    this.letterFor(status.id);
    if (!prev || prev.connected !== status.connected || prev.state !== status.state) {
      this.log(status.connected ? 'info' : 'warn', `${this.deviceLabel(status.id)} (${status.model}): ${status.state}`);
    }
    this.emit('device', this.deviceView(status));
  }

  sensors(deviceId: string, values: SensorValue[], at: number): void {
    const letter = this.letterFor(deviceId);
    for (const s of values) {
      const id = `${letter}${s.index + 1}`;
      const info: ChannelInfo = { id, deviceId, index: s.index, kind: s.kind, ...(s.name ? { name: s.name } : {}) };
      if (this.store.registerChannel(info)) {
        this.log('info', `New sensor ${id} (${s.kind}) on ${this.deviceLabel(deviceId)}`);
        this.emit('cook', this.store.meta);
      }
      const v = s.tempC == null ? null : Math.round(s.tempC * 10) / 10;
      this.latest.set(id, { v, at });
      this.sensorStatus.set(id, s.status ?? (v == null ? 'no-probe' : 'ok'));
    }
    const dev = this.devices.get(deviceId);
    if (dev) dev.lastData = at;
  }

  log(level: LogLevel, msg: string): void {
    this.emit('log', level, msg);
  }

  // ---- sampling + alarms ---------------------------------------------------------------

  tick(): void {
    const now = this.clock.now();
    const staleMs = Math.max(15_000, this.cfg.sampleSeconds * 3000);
    const v: Record<string, number | null> = {};
    let any = false;
    for (const [id, l] of this.latest) {
      const fresh = now - l.at <= staleMs ? l.v : null;
      v[id] = fresh;
      if (fresh != null) any = true;
    }
    if (any) {
      const row: SampleRow = { t: now, v };
      this.store.appendSample(row);
      this.emit('sample', row);
    }
    this.lastAnalyses = this.withStatus(analyzeAll(this.store.meta, this.store.samples, now));
    const raised = this.alarms.evaluate({
      meta: this.store.meta,
      samples: this.store.samples,
      analyses: this.lastAnalyses,
      devices: [...this.devices.values()].map((d) => ({ ...d, name: this.deviceLabel(d.id) })),
      now,
      unit: this.cfg.unit,
    });
    for (const r of raised) this.raise(r);
    this.checkClaudeHeartbeat(now);
  }

  private claudeSilentRaised = false;

  /**
   * If Claude was checking in on a schedule during a cook and then goes quiet, the loop probably
   * died. Only armed once there's a regular rhythm (≥3 checks, typical gap ≤ 15 min), so a one-off
   * question from the Claude desktop app doesn't count as "monitoring".
   */
  private checkClaudeHeartbeat(now: number): void {
    if (this.clock.speed !== 1 || this.claudeLastCheckAt == null || this.claudeChecks.length < 3) return;
    const gaps = this.claudeChecks.slice(1).map((t, i) => t - this.claudeChecks[i]).sort((a, b) => a - b);
    const typical = gaps[gaps.length >> 1];
    if (typical > 15 * 60_000) return;
    const cooking = this.store.meta.startedAt != null && this.store.meta.endedAt == null;
    const silent = cooking && now - this.claudeLastCheckAt > Math.max(20 * 60_000, 3 * typical);
    if (silent && !this.claudeSilentRaised) {
      this.claudeSilentRaised = true;
      this.raise({
        type: 'alarm',
        code: 'claude_silent',
        severity: 'warning',
        title: 'Claude stopped checking in',
        message: 'No check-in from Claude for 20+ minutes. The Claude session may be closed, asleep, or waiting on a permission prompt. Hub alarms are still active.',
        push: true,
      });
    } else if (!silent && this.claudeSilentRaised) {
      this.claudeSilentRaised = false;
      this.raise({ type: 'alarm-cleared', code: 'claude_silent', severity: 'info', title: 'Claude is checking in again', message: '', push: false });
    }
  }

  private raise(r: RaisedAlarm): void {
    const ev = this.addEvent({
      type: r.type,
      severity: r.severity,
      code: r.code,
      channelId: r.channelId,
      title: r.title,
      message: r.message,
      source: 'hub',
      ...(r.ref != null ? { ref: r.ref } : {}),
    });
    if (r.type === 'alarm' || r.push) this.notifier.send({ title: r.title, message: r.message, severity: r.severity, push: r.push });
    this.emit('alarm', ev, r.push);
  }

  addEvent(e: Omit<CookEvent, 'id' | 'at'> & { at?: number }): CookEvent {
    const ev = this.store.addEvent({ ...e, at: e.at ?? this.clock.now() });
    this.emit('event', ev);
    return ev;
  }

  // ---- operations used by the HTTP API / MCP ------------------------------------------

  markClaudeCheck(): void {
    const now = this.clock.now();
    // collapse bursts (a check-in that calls the report twice) into one
    if (this.claudeLastCheckAt == null || now - this.claudeLastCheckAt > 60_000) this.claudeChecks = [...this.claudeChecks, now].slice(-6);
    this.claudeLastCheckAt = now;
  }

  addNote(text: string, source: CookEvent['source'] = 'user', at?: number): CookEvent {
    this.source.onNote?.(text);
    return this.addEvent({ type: 'note', severity: 'info', title: text, source, at });
  }

  sendAlert(a: { title: string; message: string; severity: Severity }): CookEvent {
    const ev = this.addEvent({ type: 'claude', severity: a.severity, title: a.title, message: a.message, source: 'claude' });
    this.notifier.send({ ...a, push: true });
    this.emit('alarm', ev, true);
    return ev;
  }

  updateCook(u: CookUpdate): CookMeta {
    const m = this.store.meta;
    if (u.name !== undefined) m.name = u.name;
    if (u.meat !== undefined) m.meat = u.meat;
    if (u.weightKg !== undefined) m.weightKg = u.weightKg;
    if (u.method !== undefined) m.method = u.method;
    if (u.goal !== undefined) m.goal = u.goal;
    if (u.serveAt !== undefined) m.serveAt = u.serveAt ?? undefined;
    for (const [id, patch] of Object.entries(u.channels ?? {})) {
      if (!m.channels[id]) throw new Error(`Unknown channel "${id}". Known: ${Object.keys(m.channels).join(', ') || 'none yet (no thermometer data received)'}`);
      const s = (m.settings[id] ??= {});
      for (const key of ['label', 'role', 'targetC', 'lowC', 'highC'] as const) {
        if (!(key in patch)) continue;
        const val = patch[key];
        if (val === null || val === undefined) delete s[key];
        else (s as Record<string, unknown>)[key] = val;
      }
    }
    this.store.saveMeta();
    this.emit('cook', m);
    return m;
  }

  startCook(u: CookUpdate & { newSession?: boolean; startedAt?: number }): CookMeta {
    const now = this.clock.now();
    const cur = this.store.meta;
    // Reuse the current log (it holds the warm-up) unless asked for a fresh one or it's finished/stale.
    const stale = cur.startedAt != null && now - cur.startedAt > 36 * 3600_000;
    if (u.newSession || cur.endedAt != null || stale) {
      if (cur.endedAt == null) this.endCook('Superseded by a new cook');
      this.store = CookStore.create(this.dataDir, now, cur.channels);
      this.alarms = new AlarmEngine();
      this.log('info', `New cook log at ${this.store.dir}`);
    }
    this.updateCook(u);
    if (this.store.meta.startedAt == null || u.startedAt) {
      this.store.meta.startedAt = u.startedAt ?? now;
      this.store.saveMeta();
      this.addEvent({ type: 'system', severity: 'info', title: `Cook started: ${this.store.meta.name}`, source: 'hub' });
    }
    this.emit('cook', this.store.meta);
    return this.store.meta;
  }

  endCook(summary?: string): CookMeta {
    const m = this.store.meta;
    if (m.endedAt == null) {
      m.endedAt = this.clock.now();
      this.store.saveMeta();
      this.addEvent({ type: 'system', severity: 'info', title: 'Cook ended', message: summary, source: 'hub' });
    }
    this.emit('cook', m);
    return m;
  }

  // ---- views ----------------------------------------------------------------------------

  private letterFor(deviceId: string): string {
    const prefs = (this.cfg.devices[deviceId] ??= {});
    if (!prefs.letter) {
      const used = new Set(Object.values(this.cfg.devices).map((d) => d.letter));
      prefs.letter = [...LETTERS].find((l) => !used.has(l)) ?? '?';
      if (this.mode === 'ble') {
        try {
          saveConfig(this.cfg);
        } catch (err) {
          this.log('warn', `Could not save config: ${(err as Error).message}`);
        }
      }
    }
    return prefs.letter;
  }

  deviceLabel(deviceId: string): string {
    const prefs = this.cfg.devices[deviceId];
    const d = this.devices.get(deviceId);
    return prefs?.alias || `Thermometer ${prefs?.letter ?? '?'}${d ? ` (${d.name})` : ''}`;
  }

  private deviceView(d: DeviceStatus): DeviceView {
    const prefs = this.cfg.devices[d.id];
    return { ...d, letter: prefs?.letter ?? '?', alias: prefs?.alias ?? `Thermometer ${prefs?.letter ?? '?'}` };
  }

  private withStatus(list: ChannelAnalysis[]): ChannelAnalysis[] {
    for (const a of list) a.sensorStatus = this.sensorStatus.get(a.id);
    return list;
  }

  snapshot(): HubSnapshot {
    const now = this.clock.now();
    const active = new Map<string, CookEvent>();
    for (const e of this.store.events) {
      const key = `${e.code}:${e.channelId ?? ''}`;
      if (e.type === 'alarm' && e.code) active.set(key, e);
      else if (e.type === 'alarm-cleared' && e.code) active.delete(key);
    }
    return {
      now,
      unit: this.cfg.unit,
      mode: this.source.kind,
      speed: this.clock.speed,
      cook: this.store.meta,
      analyses: this.withStatus(analyzeAll(this.store.meta, this.store.samples, now)),
      devices: [...this.devices.values()].map((d) => this.deviceView(d)),
      activeAlarms: [...active.values()],
      recentEvents: this.store.events.slice(-50),
      claudeLastCheckAt: this.claudeLastCheckAt,
    };
  }
}
