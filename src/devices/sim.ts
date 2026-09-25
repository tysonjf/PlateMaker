// A physically-flavoured smoker simulator shaped like a real INT-12-BW kit: one base with a
// black probe (meat tip + ambient) and a white probe (meat tip only). Includes the stall, lid
// openings, a fire that slowly dies until you log "added fuel", and wrapping when you log "wrap".

import type { DeviceSource, DeviceStatus, SensorValue, SourceSink } from './types.ts';
import type { Clock } from '../hub/hub.ts';

const HOUR = 3_600_000;
const SIM_ID = 'sim-int12bw';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface MeatState {
  temp: number;
  /** Heat transfer coefficient per hour (bigger cut = smaller k). */
  k: number;
  /** Evaporative "stall reservoir", 1 → 0. */
  moisture: number;
  wrapped: boolean;
}

export interface SimOptions {
  seed?: number;
  /** Pit set point in °C. */
  pitSetC?: number;
  /** Hours into the cook when the fire starts dying (until fuel is added). */
  fireDiesAtH?: number;
  /** Start the simulation this many hours into a cook (history is backfilled instantly). */
  startHours?: number;
}

export class SimSource implements DeviceSource {
  readonly kind = 'sim' as const;
  private clock: Clock;
  private rand: () => number;
  private sink: SourceSink | null = null;
  private timer: NodeJS.Timeout | null = null;
  private t: number;
  private readonly t0: number;
  private pit: number;
  private pitSet: number;
  private fireOutput = 1; // 1 = healthy fire
  private fireDiesAt: number;
  private refueledAt = -Infinity;
  private lidOpenUntil = -Infinity;
  private nextLidAt: number;
  private meats: MeatState[];
  private battery = { base: 86, black: 100, white: 97 };
  readonly startHours: number;

  constructor(clock: Clock, opts: SimOptions = {}) {
    this.clock = clock;
    this.rand = mulberry32(opts.seed ?? 42);
    this.startHours = opts.startHours ?? 0;
    const now = clock.now();
    this.t0 = now - this.startHours * HOUR;
    this.t = this.t0;
    this.pitSet = opts.pitSetC ?? 121;
    this.pit = this.pitSet - 3;
    // By default the fire starts to fade ~40 min after "now", so a live demo has something to catch.
    this.fireDiesAt = this.t0 + (opts.fireDiesAtH ?? this.startHours + 0.66) * HOUR;
    this.nextLidAt = this.t0 + (1.2 + this.rand()) * HOUR;
    this.meats = [
      { temp: 4, k: 0.17, moisture: 1, wrapped: false },
      { temp: 4, k: 0.2, moisture: 1, wrapped: false },
    ];
  }

  private noise(scale: number): number {
    return (this.rand() - 0.5) * 2 * scale;
  }

  /** Advance the physics to time `to` in small steps. */
  private step(to: number): void {
    const dtMs = 5_000;
    while (this.t < to) {
      const dt = Math.min(dtMs, to - this.t) / HOUR;
      this.t += dt * HOUR;
      // Fire slowly dies after fireDiesAt unless refuelled after that point.
      if (this.t > this.fireDiesAt && this.refueledAt < this.fireDiesAt) {
        this.fireOutput = Math.max(0.35, this.fireOutput - dt * 0.45);
      } else {
        this.fireOutput = Math.min(1, this.fireOutput + dt * 3);
      }
      // Lid openings every ~1–2h (spritz / checking the bark).
      if (this.t >= this.nextLidAt) {
        this.lidOpenUntil = this.t + (0.6 + this.rand() * 0.8) * 60_000;
        this.nextLidAt = this.t + (1 + this.rand() * 1.2) * HOUR;
      }
      const lidOpen = this.t < this.lidOpenUntil;
      // Slow fuel-burn cycle (±1.5°C over ~50 min) on top of the set point.
      const cycle = 1.5 * Math.sin((((this.t - this.t0) / HOUR) * 2 * Math.PI) / 0.83);
      const target = (this.pitSet + cycle) * this.fireOutput + 20 * (1 - this.fireOutput);
      const pull = lidOpen ? (70 - this.pit) * 60 : (target - this.pit) * 12;
      this.pit += pull * dt + this.noise(0.3);
      if (this.pit < 20) this.pit = 20;

      for (const m of this.meats) {
        const heat = m.k * (this.pit - m.temp);
        // Evaporative cooling ramps in from ~60°C and is mostly gone once the surface dries or it's wrapped.
        const ramp = Math.min(1, Math.max(0, (m.temp - 57) / 7));
        const strength = Math.min(1, m.moisture * 1.6) * (m.wrapped ? 0.25 : 0.97);
        const evap = heat * ramp * strength;
        m.temp += (heat - evap) * dt;
        m.moisture = Math.max(0, m.moisture - dt * ramp * (m.wrapped ? 0.5 : 0.2));
      }
    }
  }

  private readings(): Map<string, SensorValue[]> {
    const jitter = () => this.noise(0.08);
    return new Map([
      [
        SIM_ID,
        [
          { index: 0, kind: 'meat' as const, name: 'Black probe', tempC: this.meats[0].temp + jitter(), status: 'ok' as const },
          { index: 1, kind: 'ambient' as const, name: 'Black probe (ambient)', tempC: this.pit + this.noise(0.4), status: 'ok' as const },
          { index: 2, kind: 'meat' as const, name: 'White probe', tempC: this.meats[1].temp + jitter(), status: 'ok' as const },
        ],
      ],
    ]);
  }

  private status(): DeviceStatus {
    const batteries = {
      base: Math.round(this.battery.base),
      'black probe': Math.round(this.battery.black),
      'white probe': Math.round(this.battery.white),
    };
    return {
      id: SIM_ID,
      name: 'Int12bw (simulated)',
      model: 'INT-12-BW',
      connected: true,
      rssi: Math.round(-61 + this.noise(3)),
      batteryPct: Math.min(...Object.values(batteries)),
      batteries,
      lastSeen: this.t,
      lastData: this.t,
      state: 'streaming (simulated)',
    };
  }

  /** Instantly generate history from the virtual cook start until now. */
  *backfill(stepMs: number): Generator<{ t: number; values: Map<string, SensorValue[]> }> {
    const end = this.clock.now();
    for (let t = this.t0 + stepMs; t < end; t += stepMs) {
      this.step(t);
      yield { t, values: this.readings() };
    }
  }

  get cookStart(): number {
    return this.t0;
  }

  async start(sink: SourceSink): Promise<void> {
    this.sink = sink;
    sink.log('info', `Simulator running${this.clock.speed !== 1 ? ` at ×${this.clock.speed} speed` : ''}. Log a note with "fuel" to refuel, "wrap" to wrap the meat.`);
    const emit = () => {
      const before = this.t;
      this.step(this.clock.now());
      const hours = (this.t - before) / HOUR;
      this.battery.base = Math.max(5, this.battery.base - hours * 2);
      this.battery.black = Math.max(5, this.battery.black - hours * 1.5);
      this.battery.white = Math.max(5, this.battery.white - hours * 1.5);
      sink.device(this.status());
      for (const [id, values] of this.readings()) sink.sensors(id, values, this.t);
    };
    emit();
    this.timer = setInterval(emit, Math.max(250, 2000 / this.clock.speed));
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** React to cook notes so Claude's advice can be "acted on" in a demo. */
  onNote(text: string): void {
    const s = text.toLowerCase();
    if (/(fuel|charcoal|wood|split|pellet|log|coals|refill|stoke)/.test(s)) {
      this.refueledAt = this.t;
      this.fireOutput = Math.max(this.fireOutput, 0.8);
      this.fireDiesAt = this.t + (4 + this.rand() * 2) * HOUR;
      this.sink?.log('info', 'Simulator: fire refuelled.');
    }
    if (/wrap/.test(s)) {
      for (const m of this.meats) m.wrapped = true;
      this.sink?.log('info', 'Simulator: meat wrapped.');
    }
    if (/unwrap/.test(s)) for (const m of this.meats) m.wrapped = false;
  }
}
