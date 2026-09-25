import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectStall, findDips, robustSlopePerHour, windowSlope, type Point } from '../src/hub/analytics.ts';
import { AlarmEngine } from '../src/hub/alarms.ts';
import { analyzeAll } from '../src/hub/analytics.ts';
import type { CookMeta, SampleRow } from '../src/hub/store.ts';

const MIN = 60_000;
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 8, 26, 12, 0, 0);

/** Build a series from a function of hours since T0, sampled every `stepS` seconds. */
function series(hours: number, fn: (h: number) => number, stepS = 30): Point[] {
  const out: Point[] = [];
  for (let t = 0; t <= hours * HOUR; t += stepS * 1000) out.push({ t: T0 + t, v: fn(t / HOUR) });
  return out;
}

test('robust slope ignores a lid-open dip that least squares would chase', () => {
  const pts = series(1, (h) => 120 + 2 * h + (h > 0.5 && h < 0.55 ? -30 : 0));
  const r = robustSlopePerHour(pts)!;
  assert.ok(Math.abs(r - 2) < 0.5, `slope ${r}`);
});

test('windowSlope returns null without enough coverage', () => {
  const pts = series(0.1, () => 100);
  assert.equal(windowSlope(pts, T0 + 0.1 * HOUR, 60), null);
});

test('detects the stall after a climb, not meat that cooled into the band', () => {
  // climb 10 → 66 °C over 5h, then flat for 2h
  const stall = series(7, (h) => (h < 5 ? 10 + (56 * h) / 5 : 66 + 0.3 * (h - 5)));
  const now = stall.at(-1)!.t;
  const s = detectStall(stall, now);
  assert.ok(s, 'stall detected');
  // true plateau began at 5h (120 min ago); the ±4 °C band may start it a little earlier
  assert.ok(s!.minutes > 100 && s!.minutes < 160, `stall minutes ${s!.minutes}`);

  // Meat resting after the cook cools *into* the band and sits there: not a stall.
  const resting = series(4, (h) => (h < 1 ? 85 - 19 * h : 66));
  assert.equal(detectStall(resting, resting.at(-1)!.t), null, 'cooled into the band → not a stall');

  const climbing = series(5, (h) => 10 + 12 * h);
  assert.equal(detectStall(climbing, climbing.at(-1)!.t), null, 'still climbing → not a stall');
});

test('findDips reports each lid opening once, with recovery', () => {
  const pts = series(1, (h) => {
    const m = h * 60;
    if (m >= 20 && m < 21.5) return 120 - (m - 20) * 30; // drops ~45 °C
    if (m >= 21.5 && m < 30) return 75 + (m - 21.5) * 5.3; // recovers
    return 120;
  }, 10);
  const dips = findDips(pts, pts.at(-1)!.t, 90);
  assert.equal(dips.length, 1, JSON.stringify(dips));
  assert.ok(dips[0].dropC > 35);
  assert.equal(dips[0].recovered, true);
});

function cook(): CookMeta {
  return {
    id: 't',
    name: 'Test',
    createdAt: T0,
    startedAt: T0,
    endedAt: null,
    channels: {
      A1: { id: 'A1', deviceId: 'd', index: 0, kind: 'meat', name: 'Black probe' },
      A2: { id: 'A2', deviceId: 'd', index: 1, kind: 'ambient' },
    },
    settings: { A1: { targetC: 95 }, A2: { lowC: 107, highC: 135 } },
  };
}

function rows(hours: number, meat: (h: number) => number, pit: (h: number) => number): SampleRow[] {
  const out: SampleRow[] = [];
  for (let t = 0; t <= hours * HOUR; t += 5000) out.push({ t: T0 + t, v: { A1: meat(t / HOUR), A2: pit(t / HOUR) } });
  return out;
}

test('alarms: fire dying raises pit alarms once, then clears; restart does not re-fire', () => {
  const meta = cook();
  // pit steady at 121 °C for 3h, then falls ~40 °C/h
  const pit = (h: number) => (h < 3 ? 121 : Math.max(60, 121 - 40 * (h - 3)));
  const all = rows(4, (h) => 20 + 12 * h, pit);
  const engine = new AlarmEngine();
  const raised: string[] = [];
  for (let i = 0; i < all.length; i += 12) {
    const samples = all.slice(0, i + 1);
    const now = samples.at(-1)!.t;
    const analyses = analyzeAll(meta, samples, now);
    for (const r of engine.evaluate({ meta, samples, analyses, devices: [], now, unit: 'F' })) raised.push(`${r.type}:${r.code}`);
  }
  assert.ok(raised.includes('alarm:pit_falling'), raised.join(','));
  assert.ok(raised.includes('alarm:pit_low'), raised.join(','));
  // one alert plus at most one 30-minute "still" reminder over the hour
  assert.ok(raised.filter((r) => r === 'alarm:pit_falling').length <= 2, 'no nagging within the renotify window');

  // A new engine restored from the event log must not re-announce the active alarm.
  const events = raised.map((r, i) => {
    const [type, code] = r.split(':');
    return { id: i + 1, at: T0 + 3.5 * HOUR, type: type as 'alarm', severity: 'warning' as const, code, channelId: 'A2', title: code, source: 'hub' as const };
  });
  const restored = new AlarmEngine();
  restored.restore(events);
  const now = all.at(-1)!.t;
  const again = restored.evaluate({ meta, samples: all, analyses: analyzeAll(meta, all, now), devices: [], now, unit: 'F' });
  assert.ok(!again.some((r) => r.type === 'alarm' && r.code === 'pit_low' && !r.title.startsWith('Still')), JSON.stringify(again));
});

test('alarms: target reached fires once with hysteresis', () => {
  const meta = cook();
  const all = rows(2, (h) => 90 + 4 * h, () => 121); // crosses 95 °C at 1.25h
  const engine = new AlarmEngine();
  const codes: string[] = [];
  for (let i = 0; i < all.length; i += 12) {
    const samples = all.slice(0, i + 1);
    const now = samples.at(-1)!.t;
    for (const r of engine.evaluate({ meta, samples, analyses: analyzeAll(meta, samples, now), devices: [], now, unit: 'F' })) codes.push(r.code);
  }
  assert.equal(codes.filter((c) => c === 'target_reached').length, 1);
  assert.equal(codes.filter((c) => c === 'near_target').length, 1);
});

test('alarms: pit warm-up at the start does not alarm before the pit first reaches range', () => {
  const meta = cook();
  const all = rows(1, () => 5, (h) => 20 + 60 * h); // pit still climbing to 80 °C, below range
  const engine = new AlarmEngine();
  const codes: string[] = [];
  for (let i = 0; i < all.length; i += 12) {
    const samples = all.slice(0, i + 1);
    const now = samples.at(-1)!.t;
    for (const r of engine.evaluate({ meta, samples, analyses: analyzeAll(meta, samples, now), devices: [], now, unit: 'F' })) codes.push(r.code);
  }
  assert.ok(!codes.includes('pit_low'), codes.join(','));
});
