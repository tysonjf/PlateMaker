// Classic "iBBQ" protocol used by Inkbird IBT-2X / IBT-4XS / IBT-6XS and many rebadged
// thermometers. Service FFF0: FFF2 = login, FFF5 = commands, FFF4 = realtime temps, FFF1 = replies.
// References: go-ibbq (sworisbreathing), Adafruit_CircuitPython_BLE_iBBQ, cloudbbq.

import type { SensorValue } from '../types.ts';
import { hex, type Advert, type Driver, type DriverContext, type DriverSession, type GattLink } from './gatt.ts';

export const LOGIN = Buffer.from([0x21, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01, 0xb8, 0x22, 0x00, 0x00, 0x00, 0x00, 0x00]);
export const ENABLE_REALTIME = Buffer.from([0x0b, 0x01, 0x00, 0x00, 0x00, 0x00]);
export const REQUEST_BATTERY = Buffer.from([0x08, 0x24, 0x00, 0x00, 0x00, 0x00]);

/** FFF4 payload: one int16 LE per probe in °C × 10; 0xFFF6 (-10) / 0xFFFF = probe unplugged. */
export function parseRealtime(buf: Buffer): (number | null)[] {
  const out: (number | null)[] = [];
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const raw = buf.readUInt16LE(i);
    out.push(raw === 0xfff6 || raw === 0xffff ? null : buf.readInt16LE(i) / 10);
  }
  return out;
}

/** FFF1 battery reply: 24 <current mV LE16> <max mV LE16>. */
export function parseBatteryReply(buf: Buffer): number | null {
  if (buf.length < 5 || buf[0] !== 0x24) return null;
  const cur = buf.readUInt16LE(1);
  let max = buf.readUInt16LE(3);
  if (max === 0) max = 6550;
  return Math.max(0, Math.min(100, Math.round((100 * cur) / max)));
}

export async function runIbbq(link: GattLink, ctx: DriverContext, model: string): Promise<DriverSession> {
  let lastAt = 0;
  await link.subscribe('fff4', (d) => {
    lastAt = ctx.now();
    const temps = parseRealtime(d);
    const values: SensorValue[] = temps.map((t, i) => ({
      index: i,
      kind: 'meat',
      name: `Probe ${i + 1}`,
      tempC: t,
      status: t == null ? 'no-probe' : 'ok',
    }));
    ctx.sensors(values);
  });
  await link.subscribe('fff1', (d) => {
    const pct = parseBatteryReply(d);
    if (pct != null) ctx.status({ batteryPct: pct, batteries: { device: pct } });
    else ctx.log('debug', `${model} FFF1: ${hex(d)}`);
  });
  await link.write('fff2', LOGIN);
  await link.write('fff5', ENABLE_REALTIME);
  await link.write('fff5', REQUEST_BATTERY);
  ctx.status({ state: 'streaming' });
  const started = ctx.now();
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
    if (ticks % 30 === 0) link.write('fff5', REQUEST_BATTERY).catch(() => {});
    if (ctx.now() - (lastAt || started) > 90_000) ctx.reconnect('no temperature data for 90s');
  }, 10_000);
  return { stop: () => clearInterval(timer) };
}

export const ibbqDriver: Driver = {
  id: 'ibbq',
  match(adv: Advert): string | null {
    // Only match by name: FFF0 is a generic vendor service used by lots of unrelated gadgets.
    const n = adv.name.trim();
    return /^[ix]?BBQ$/i.test(n) ? n : null;
  },
  run: runIbbq,
};
