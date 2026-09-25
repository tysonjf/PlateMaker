// Inkbird "BW" protocol (INT-12-BW, and likely INT-14-BW / other INT-*-BW / IBBQ-4BW bases).
//
// Credits: reverse-engineered by Paul Faure (github.com/paul43210/inkbird-bw-ble) from BLE
// captures and the decompiled INKBIRD Android app (Idt34Helper.getBleGetVerifyCode). This is an
// independent TypeScript implementation of that documented protocol.
//
// GATT: service FF00
//   FF01 notify  temperatures, int16 LE, °C × 10 (always °C, whatever the display shows)
//   FF02 write/notify  control: frames of <LEN><TYPE><payload…>, LEN counts TYPE+payload
//   FF03 notify  probe dock/connection bits
//   2A19 notify  battery [base %, probe1 %, probe2 %] (0x7F = n/a)
// Session: 01 FB → device sends 07 FB <6-byte challenge> → we answer 08 FC <7 bytes> → 02 FC 00.
// Without a correct answer the base drops the link after ~30 s.

import type { SensorValue } from '../types.ts';
import { hex, sleep, withTimeout, type Advert, type Driver, type DriverContext, type DriverSession, type GattLink } from './gatt.ts';

export const SVC = 'ff00';
export const TEMP = 'ff01';
export const CTRL = 'ff02';
export const STATE = 'ff03';
export const BATT = '2a19';

// ---- auth ------------------------------------------------------------------------------

export function crc8(data: ArrayLike<number>, poly: number, init: number): number {
  let crc = init;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] & 0xff;
    for (let b = 0; b < 8; b++) crc = crc & 0x80 ? ((crc << 1) ^ poly) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

export const crc8DvbS2 = (d: ArrayLike<number>) => crc8(d, 0xd5, 0x00);
export const crc8Cdma2000 = (d: ArrayLike<number>) => crc8(d, 0x9b, 0xff);

/** The 7-byte body that follows `08 FC`: ms-of-second LE16, epoch seconds LE32, CRC byte. */
export function verifyBody(challenge: ArrayLike<number>, epochSeconds: number, millisRemainder: number): Buffer {
  const time6 = [
    millisRemainder & 0xff,
    (millisRemainder >> 8) & 0xff,
    epochSeconds & 0xff,
    (epochSeconds >>> 8) & 0xff,
    (epochSeconds >>> 16) & 0xff,
    (epochSeconds >>> 24) & 0xff,
  ];
  const inner = crc8DvbS2(time6);
  const cdma = crc8Cdma2000(challenge);
  return Buffer.from([...time6, crc8DvbS2([...time6, inner, cdma])]);
}

export function authFrame(challenge: ArrayLike<number>, nowMs: number): Buffer {
  const body = verifyBody(challenge, Math.floor(nowMs / 1000), nowMs % 1000);
  return Buffer.concat([Buffer.from([body.length + 1, 0xfc]), body]);
}

/** `07 19 <epoch LE32> <ms LE16>` — the base has no RTC, the app sets it on connect. */
export function clockSyncFrame(nowMs: number): Buffer {
  const b = Buffer.alloc(8);
  b[0] = 0x07;
  b[1] = 0x19;
  b.writeUInt32LE(Math.floor(nowMs / 1000) >>> 0, 2);
  b.writeUInt16LE(nowMs % 1000, 6);
  return b;
}

export const HELLO = Buffer.from([0x01, 0xfb]);

/** Same "read everything" blob the official app sends after auth (unit, targets, names, info…). */
export const INIT_FRAMES: number[][] = [
  [0x01, 0x04],
  [0x02, 0x02, 0x01],
  [0x02, 0x02, 0x02],
  [0x01, 0x06],
  [0x02, 0x0a, 0xff],
  [0x01, 0x0c],
  [0x01, 0x11],
  [0x01, 0x42],
  [0x01, 0x15],
  [0x01, 0x24],
  [0x02, 0x26, 0x01],
  [0x02, 0x26, 0x02],
  [0x02, 0x37, 0x01],
  [0x02, 0x37, 0x02],
  [0x02, 0x37, 0x03],
  [0x01, 0x41],
];

/** Ask for current temperature (FF01), probe state (FF03) and battery (2A19). */
export const POLL = Buffer.from([0x02, 0xf1, 0x01, 0x02, 0xf1, 0x03, 0x02, 0xf1, 0x19]);

/** Pack frames into writes of at most `max` bytes, only splitting between frames. */
export function chunkFrames(frames: number[][], max = 18): Buffer[] {
  const out: Buffer[] = [];
  let cur: number[] = [];
  for (const f of frames) {
    if (cur.length + f.length > max && cur.length) {
      out.push(Buffer.from(cur));
      cur = [];
    }
    cur.push(...f);
  }
  if (cur.length) out.push(Buffer.from(cur));
  return out;
}

export interface Frame {
  type: number;
  payload: Buffer;
}

/** Split a control notification into its `<LEN><TYPE><payload>` frames. */
export function splitFrames(buf: Buffer): Frame[] {
  const out: Frame[] = [];
  let i = 0;
  while (i < buf.length) {
    const len = buf[i];
    if (len === 0 || i + 1 + len > buf.length) break;
    out.push({ type: buf[i + 1], payload: buf.subarray(i + 2, i + 1 + len) });
    i += 1 + len;
  }
  return out;
}

// ---- telemetry -------------------------------------------------------------------------

const SENTINELS = new Set([32766, 32767, -32768]);

/** Signed LE16 °C×10 → °C, or null for the error / no-probe / out-of-range sentinels. */
export function decodeTemp(buf: Buffer, offset: number): number | null {
  if (buf.length < offset + 2) return null;
  const raw = buf.readInt16LE(offset);
  if (SENTINELS.has(raw)) return null;
  const c = raw / 10;
  return c < -40 || c > 600 ? null : c;
}

export interface ProbeTemps {
  tip: number | null;
  ambient: number | null;
}

export interface BwTemps {
  probes: ProbeTemps[];
  /** Temperature of the base station itself (INT-12-BW bytes 8-9), if present. */
  base: number | null;
}

/**
 * INT-12-BW: 10 bytes = [black tip][black ambient][reserved][white tip][reserved][base].
 * INT-14-BW: 18 bytes = 4 × [tip][ambient] + 2 bytes.
 */
export function parseTemps(buf: Buffer): BwTemps | null {
  if (buf.length === 18) {
    const probes: ProbeTemps[] = [];
    for (let i = 0; i < 4; i++) probes.push({ tip: decodeTemp(buf, i * 4), ambient: decodeTemp(buf, i * 4 + 2) });
    return { probes, base: decodeTemp(buf, 16) };
  }
  if (buf.length >= 7) {
    return {
      probes: [
        { tip: decodeTemp(buf, 0), ambient: decodeTemp(buf, 2) },
        { tip: decodeTemp(buf, 5), ambient: null },
      ],
      base: buf.length >= 10 ? decodeTemp(buf, 8) : null,
    };
  }
  return null;
}

export interface ProbeState {
  connected: boolean;
  /** Sitting in the base's charging dock. */
  docked: boolean;
}

/** FF03: a 16-bit block per probe, LSB-first; bit0 = connected, bit1 = charging (docked). */
export function parseProbeStates(buf: Buffer, probes: number): ProbeState[] {
  const bit = (n: number) => (buf.length > n >> 3 ? (buf[n >> 3] >> (n & 7)) & 1 : 0);
  const out: ProbeState[] = [];
  for (let p = 0; p < probes; p++) {
    if (buf.length <= p * 2) break;
    out.push({ connected: bit(p * 16) === 1, docked: bit(p * 16 + 1) === 1 });
  }
  return out;
}

export function parseBattery(buf: Buffer): { base: number | null; probes: (number | null)[] } {
  const pct = (v: number | undefined) => (v == null || v === 0x7f || v === 0xff ? null : Math.min(100, v));
  return { base: pct(buf[0]), probes: [...buf.subarray(1)].map((v) => pct(v)) };
}

/** "Int12bw" / "INT-12-BW" → "INT-12-BW". Only the Wi-Fi+BT ("-BW") bases use this protocol. */
export function matchName(name: string): string | null {
  const m = /^int(\d{2}[a-z]?)bw$/.exec(name.toLowerCase().replace(/[^a-z0-9]/g, ''));
  return m ? `INT-${m[1].toUpperCase()}-BW` : null;
}

// ---- session ---------------------------------------------------------------------------

const PROBE_NAMES_INT12 = ['Black probe', 'White probe'];

export function sensorsFromTemps(t: BwTemps, states: ProbeState[]): SensorValue[] {
  const out: SensorValue[] = [];
  const int12 = t.probes.length === 2;
  t.probes.forEach((p, i) => {
    const docked = states[i]?.docked ?? false;
    const lost = states[i] != null && !states[i].connected;
    const status = docked ? 'docked' : lost ? 'out-of-range' : undefined;
    const pname = int12 ? PROBE_NAMES_INT12[i] : `Probe ${i + 1}`;
    const tipIndex = int12 ? (i === 0 ? 0 : 2) : i * 2;
    out.push({
      index: tipIndex,
      kind: 'meat',
      name: pname,
      tempC: status ? null : p.tip,
      status: status ?? (p.tip == null ? 'no-probe' : 'ok'),
    });
    // INT-12-BW: only the black probe has an ambient sensor.
    if (!int12 || i === 0) {
      out.push({
        index: tipIndex + 1,
        kind: 'ambient',
        name: `${pname} (ambient)`,
        tempC: status ? null : p.ambient,
        status: status ?? (p.ambient == null ? 'no-probe' : 'ok'),
      });
    }
  });
  return out;
}

export async function runInkbirdBw(link: GattLink, ctx: DriverContext, model = 'INT-12-BW'): Promise<DriverSession> {
  let stopped = false;
  let challengeWaiter: ((c: Buffer) => void) | null = null;
  let ackWaiter: ((ok: boolean) => void) | null = null;
  let pendingChallenge: Buffer | null = null;
  let states: ProbeState[] = [];
  let lastTemps: BwTemps | null = null;
  let lastTempAt = 0;
  const loggedLen = new Set<number>();
  let authed = false;

  const write = (b: Buffer) => link.write(CTRL, b);

  const publish = () => {
    if (!lastTemps) return;
    ctx.sensors(sensorsFromTemps(lastTemps, states));
  };

  await link.subscribe(TEMP, (d) => {
    const t = parseTemps(d);
    if (!loggedLen.has(d.length)) {
      loggedLen.add(d.length);
      ctx.log(t ? 'debug' : 'warn', `${model} FF01 frame (${d.length} bytes): ${hex(d)}${t ? '' : ' — unrecognised layout'}`);
    }
    if (!t) return;
    lastTemps = t;
    lastTempAt = ctx.now();
    publish();
  });

  await link.subscribe(CTRL, (d) => {
    for (const f of splitFrames(d)) {
      if (f.type === 0xfb && f.payload.length >= 6) {
        const c = Buffer.from(f.payload.subarray(0, 6));
        if (challengeWaiter) challengeWaiter(c);
        else pendingChallenge = c;
      } else if (f.type === 0xfc) {
        const ok = f.payload[0] === 0x00;
        if (ackWaiter) ackWaiter(ok);
        else ctx.log(ok ? 'debug' : 'warn', `${model} auth status ${hex(f.payload)}`);
      } else {
        ctx.log('debug', `${model} FF02 type 0x${f.type.toString(16).padStart(2, '0')}: ${hex(f.payload)}`);
      }
    }
  });

  if (link.has(STATE)) {
    await link.subscribe(STATE, (d) => {
      const next = parseProbeStates(d, lastTemps?.probes.length ?? 2);
      const changed = JSON.stringify(next) !== JSON.stringify(states);
      states = next;
      if (changed) {
        const desc = next
          .map((s, i) => `${(lastTemps?.probes.length ?? 2) === 2 ? PROBE_NAMES_INT12[i] : `Probe ${i + 1}`}: ${s.docked ? 'in dock' : s.connected ? 'in use' : 'not connected'}`)
          .join(', ');
        ctx.log('info', `${model} probes — ${desc}`);
        ctx.status({ state: authed ? `streaming · ${desc}` : desc });
        publish();
      }
    });
  }

  if (link.has(BATT)) {
    const onBattery = (d: Buffer) => {
      const b = parseBattery(d);
      const batteries: Record<string, number> = {};
      if (b.base != null) batteries.base = b.base;
      b.probes.forEach((v, i) => {
        if (v != null) batteries[(i < 2 ? PROBE_NAMES_INT12[i] : `Probe ${i + 1}`).toLowerCase()] = v;
      });
      const vals = Object.values(batteries);
      ctx.status({ batteries, batteryPct: vals.length ? Math.min(...vals) : null });
    };
    await link.subscribe(BATT, onBattery);
    link.read(BATT).then(onBattery, () => {});
  }

  for (const extra of ['ff04', 'ff05', 'ff06']) {
    if (link.has(extra)) await link.subscribe(extra, (d) => ctx.log('debug', `${model} ${extra}: ${hex(d)}`)).catch(() => {});
  }

  await sleep(800);

  // --- handshake ---
  const getChallenge = async (): Promise<Buffer | null> => {
    for (let attempt = 0; attempt < 2 && !stopped; attempt++) {
      if (pendingChallenge) break;
      const got = new Promise<Buffer>((resolve) => (challengeWaiter = resolve));
      await write(HELLO);
      try {
        return await withTimeout(got, 6000, 'auth challenge');
      } catch {
        ctx.log('warn', `${model}: no auth challenge yet (attempt ${attempt + 1})`);
      } finally {
        challengeWaiter = null;
      }
    }
    const c = pendingChallenge;
    pendingChallenge = null;
    return c;
  };

  const challenge = await getChallenge();
  if (challenge) {
    const ack = new Promise<boolean>((resolve) => (ackWaiter = resolve));
    await write(authFrame(challenge, ctx.now()));
    try {
      authed = await withTimeout(ack, 5000, 'auth acknowledgement');
    } catch {
      // Some firmware may not ACK; if temperatures keep flowing past ~30 s we're fine.
      ctx.log('warn', `${model}: no auth ACK — continuing; will reconnect if the base drops us`);
    } finally {
      ackWaiter = null;
    }
    ctx.log(authed ? 'info' : 'warn', `${model}: ${authed ? 'authenticated' : 'auth not confirmed'}`);
  } else {
    ctx.log('warn', `${model}: base never sent an auth challenge — reading unauthenticated (expect a reconnect every ~30 s)`);
  }

  await write(clockSyncFrame(ctx.now()));
  for (const chunk of chunkFrames(INIT_FRAMES)) await write(chunk);
  await write(POLL);
  ctx.status({ state: authed ? 'streaming' : 'streaming (unauthenticated)' });

  // Watchdog: nudge with a poll when quiet, and force a reconnect if the base goes silent.
  const connectedAt = ctx.now();
  const timer = setInterval(() => {
    if (stopped) return;
    const quiet = ctx.now() - (lastTempAt || connectedAt);
    if (quiet > 120_000) {
      ctx.reconnect(`no temperature data for ${Math.round(quiet / 1000)}s`);
    } else if (quiet > 15_000) {
      write(POLL).catch((e) => ctx.log('debug', `poll failed: ${(e as Error).message}`));
    }
  }, 10_000);

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export const inkbirdBwDriver: Driver = {
  id: 'inkbird-bw',
  match(adv: Advert): string | null {
    const byName = matchName(adv.name);
    if (byName) return byName;
    return null;
  },
  run(link, ctx, model) {
    return runInkbirdBw(link, ctx, model);
  },
};
