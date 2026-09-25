// Pure, deterministic cook analytics. Claude gets these numbers pre-computed so it can
// spend its effort on judgement instead of arithmetic over raw samples.

import type { ChannelInfo, ChannelRole, ChannelSettings, CookMeta, SampleRow } from './store.ts';
import type { SensorKind, SensorStatus } from '../devices/types.ts';

export interface Point {
  t: number;
  v: number;
}

const MIN = 60_000;
const HOUR = 3_600_000;

/** Stall happens while evaporative cooling balances heat input, typically 145–175°F. */
export const STALL_LOW_C = 60;
export const STALL_HIGH_C = 82;

export function channelSeries(samples: SampleRow[], id: string, fromT = -Infinity, toT = Infinity): Point[] {
  const out: Point[] = [];
  let i = lowerBound(samples, fromT);
  for (; i < samples.length; i++) {
    const row = samples[i];
    if (row.t > toT) break;
    const v = row.v[id];
    if (v != null && Number.isFinite(v)) out.push({ t: row.t, v });
  }
  return out;
}

function lowerBound(samples: SampleRow[], t: number): number {
  let lo = 0;
  let hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Least-squares slope in °C per hour. */
export function slopePerHour(pts: Point[]): number | null {
  if (pts.length < 3) return null;
  const t0 = pts[0].t;
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const p of pts) {
    const x = (p.t - t0) / HOUR;
    n++;
    sx += x;
    sy += p.v;
    sxx += x * x;
    sxy += x * p.v;
  }
  const den = n * sxx - sx * sx;
  if (den <= 1e-12) return null;
  return (n * sxy - sx * sy) / den;
}

/**
 * Theil–Sen slope (median of pairwise slopes) in °C per hour. Robust to short excursions such as
 * a lid-open dip, which would drag a least-squares fit around.
 */
export function robustSlopePerHour(pts: Point[]): number | null {
  if (pts.length < 3) return null;
  const slopes: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dt = (pts[j].t - pts[i].t) / HOUR;
      if (dt > 0) slopes.push((pts[j].v - pts[i].v) / dt);
    }
  }
  if (!slopes.length) return null;
  slopes.sort((a, b) => a - b);
  const mid = slopes.length >> 1;
  return slopes.length % 2 ? slopes[mid] : (slopes[mid - 1] + slopes[mid]) / 2;
}

/** Trend over the trailing window; null unless the data covers most of the window. */
export function windowSlope(pts: Point[], now: number, minutes: number): number | null {
  const from = now - minutes * MIN;
  const win = pts.filter((p) => p.t >= from && p.t <= now);
  if (win.length < 3) return null;
  if (win.at(-1)!.t - win[0].t < minutes * MIN * 0.6) return null;
  // ~30–60 buckets keeps the pairwise median cheap while ignoring sample noise
  const bucket = Math.max(15_000, Math.round((minutes * MIN) / 45 / 15_000) * 15_000);
  return robustSlopePerHour(bucketize(win, bucket));
}

export interface Stats {
  min: number;
  max: number;
  mean: number;
  std: number;
  n: number;
}

export function stats(pts: Point[]): Stats | null {
  if (!pts.length) return null;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const p of pts) {
    if (p.v < min) min = p.v;
    if (p.v > max) max = p.v;
    sum += p.v;
  }
  const mean = sum / pts.length;
  let sq = 0;
  for (const p of pts) sq += (p.v - mean) ** 2;
  return { min, max, mean, std: Math.sqrt(sq / pts.length), n: pts.length };
}

export function windowStats(pts: Point[], now: number, minutes: number): Stats | null {
  const from = now - minutes * MIN;
  return stats(pts.filter((p) => p.t >= from && p.t <= now));
}

/** Average points into fixed buckets (bucket start timestamps). */
export function bucketize(pts: Point[], bucketMs: number): Point[] {
  const out: Point[] = [];
  let cur = NaN;
  let sum = 0;
  let n = 0;
  for (const p of pts) {
    const b = Math.floor(p.t / bucketMs) * bucketMs;
    if (b !== cur) {
      if (n) out.push({ t: cur, v: sum / n });
      cur = b;
      sum = 0;
      n = 0;
    }
    sum += p.v;
    n++;
  }
  if (n) out.push({ t: cur, v: sum / n });
  return out;
}

export interface Stall {
  since: number;
  minutes: number;
  rate45: number;
}

/**
 * Detect "the stall": meat in the 140–180°F band whose temperature has been roughly flat for
 * 40+ minutes after climbing into it.
 */
export function detectStall(pts: Point[], now: number): Stall | null {
  if (pts.length < 10) return null;
  const cur = pts.at(-1)!.v;
  if (cur < STALL_LOW_C || cur > STALL_HIGH_C) return null;
  const rate45 = windowSlope(pts, now, 45);
  if (rate45 == null || rate45 > 1.5 || rate45 < -2.5) return null;
  const b = bucketize(pts, 5 * MIN);
  let i = b.length - 1;
  while (i > 0 && Math.abs(b[i - 1].v - cur) <= 3) i--;
  const since = b[i].t;
  const minutes = (now - since) / MIN;
  if (minutes < 40) return null;
  if (i > 0) {
    // Must have climbed into the plateau; a probe sitting in a warm oven at 150°F for an hour isn't a stall.
    const before = b[Math.max(0, i - 6)];
    if (cur - before.v < 4) return null;
  } else if (minutes < 60 || cur < 62 || cur > 76) {
    // All the data we have is the plateau (hub restarted mid-stall): only call it in the classic band.
    return null;
  }
  return { since, minutes, rate45 };
}

export interface Dip {
  /** Last high point before the drop. */
  at: number;
  /** Bottom of the dip — stable identity for de-duplication. */
  lowAt: number;
  /** When it climbed back (only if recovered). */
  endAt: number | null;
  dropC: number;
  recovered: boolean;
  /** The bottom is behind us (readings have started climbing), so dropC is final. */
  bottomed: boolean;
}

/**
 * Sharp pit drops (lid opened, mop/spritz, adding a cold chunk of meat…): ≥10°C inside 3 minutes.
 * `recovered` = climbed back within 8°C of the pre-dip level inside 15 minutes.
 */
export function findDips(pts: Point[], now: number, lookbackMin = 60): Dip[] {
  const b = bucketize(
    pts.filter((p) => p.t >= now - (lookbackMin + 20) * MIN),
    30_000,
  );
  const dips: Dip[] = [];
  for (let i = 0; i < b.length; i++) {
    if (b[i].t < now - lookbackMin * MIN) continue;
    // first bucket within 3 minutes that is ≥10°C below this one
    let hit = -1;
    for (let j = i + 1; j < b.length && b[j].t - b[i].t <= 3 * MIN; j++) {
      if (b[i].v - b[j].v >= 10) {
        hit = j;
        break;
      }
    }
    if (hit < 0) continue;
    // follow the descent to the true bottom, and measure from the last high point before it
    let low = hit;
    while (low + 1 < b.length && b[low + 1].v <= b[low].v) low++;
    let peak = i;
    for (let k = i; k < hit; k++) if (b[k].v >= b[peak].v) peak = k;
    let endAt: number | null = null;
    for (let k = low + 1; k < b.length && b[k].t - b[low].t <= 15 * MIN; k++) {
      if (b[k].v >= b[peak].v - 8) {
        endAt = b[k].t + 30_000;
        break;
      }
    }
    const bottomed = b.at(-1)!.v > b[low].v + 2;
    dips.push({ at: b[peak].t, lowAt: b[low].t, endAt, dropC: b[peak].v - b[low].v, recovered: endAt != null, bottomed });
    i = low;
  }
  return dips;
}

export type RangeStatus = 'ok' | 'low' | 'high' | 'unknown';

export interface ChannelAnalysis {
  id: string;
  deviceId: string;
  label: string;
  role: ChannelRole;
  kind: SensorKind;
  current: number | null;
  lastAt: number | null;
  ageSec: number | null;
  /** Live sensor state from the device (docked, no probe…), filled in by the hub. */
  sensorStatus?: SensorStatus;
  rate15: number | null;
  rate30: number | null;
  rate60: number | null;
  stats10: Stats | null;
  stats30: Stats | null;
  // meat
  targetC?: number;
  remainingC?: number;
  eta30Min?: number | null;
  eta60Min?: number | null;
  stall?: Stall | null;
  peakC?: number | null;
  /** When the meat first crossed 140°F (60°C), for the "40–140°F" food safety guideline. */
  crossed60At?: number | null;
  // pit
  lowC?: number;
  highC?: number;
  rangeStatus?: RangeStatus;
  outOfRangeMin?: number;
  dips?: Dip[];
}

export function defaultLabel(info: ChannelInfo, role: ChannelRole): string {
  if (role === 'pit') return 'Pit';
  return info.name && info.kind === 'meat' ? info.name : `Probe ${info.id}`;
}

export function roleFor(info: ChannelInfo, s: ChannelSettings | undefined): ChannelRole {
  return s?.role ?? (info.kind === 'ambient' ? 'pit' : 'meat');
}

function etaMinutes(cur: number, target: number, rate: number | null): number | null {
  if (rate == null || rate < 0.3) return null;
  if (cur >= target) return 0;
  return ((target - cur) / rate) * 60;
}

export function analyzeChannel(meta: CookMeta, samples: SampleRow[], id: string, now: number): ChannelAnalysis {
  const info = meta.channels[id];
  const s = meta.settings[id];
  const role = roleFor(info, s);
  const pts = channelSeries(samples, id, now - 6 * HOUR, now);
  const last = pts.at(-1) ?? null;
  // Pit trends skip lid-open dips that recovered, so a spritz doesn't read as "falling fast".
  // Drops that never recovered stay in: that's a fire going out, not a lid.
  const dips = role === 'pit' ? findDips(pts, now, 6 * 60) : [];
  const trendPts = dips.some((d) => d.recovered)
    ? pts.filter((p) => !dips.some((d) => d.endAt != null && p.t >= d.at && p.t <= d.endAt))
    : pts;
  const fresh = last && now - last.t < 2 * MIN ? last : null;
  const a: ChannelAnalysis = {
    id,
    deviceId: info.deviceId,
    label: s?.label || defaultLabel(info, role),
    role,
    kind: info.kind,
    current: fresh ? fresh.v : null,
    lastAt: last?.t ?? null,
    ageSec: last ? Math.round((now - last.t) / 1000) : null,
    rate15: windowSlope(trendPts, now, 15),
    rate30: windowSlope(trendPts, now, 30),
    rate60: windowSlope(trendPts, now, 60),
    stats10: windowStats(trendPts, now, 10),
    stats30: windowStats(trendPts, now, 30),
  };

  if (role === 'meat') {
    a.stall = detectStall(pts, now);
    const since = meta.startedAt ?? meta.createdAt;
    const all = channelSeries(samples, id, since, now);
    a.peakC = all.length ? Math.max(...all.map((p) => p.v)) : null;
    a.crossed60At = all.find((p) => p.v >= 60)?.t ?? null;
    if (s?.targetC != null) {
      a.targetC = s.targetC;
      if (a.current != null) {
        a.remainingC = s.targetC - a.current;
        a.eta30Min = etaMinutes(a.current, s.targetC, a.rate30);
        a.eta60Min = etaMinutes(a.current, s.targetC, a.rate60);
      }
    }
  }

  if (role === 'pit') {
    a.lowC = s?.lowC;
    a.highC = s?.highC;
    a.dips = dips.filter((d) => d.at >= now - 60 * MIN);
    a.rangeStatus = 'unknown';
    const recent = windowStats(pts, now, 3);
    if (recent && (s?.lowC != null || s?.highC != null)) {
      const status = (v: number): RangeStatus =>
        s?.lowC != null && v < s.lowC ? 'low' : s?.highC != null && v > s.highC ? 'high' : 'ok';
      a.rangeStatus = status(recent.mean);
      if (a.rangeStatus !== 'ok') {
        const b = bucketize(pts, MIN);
        let i = b.length - 1;
        while (i > 0 && status(b[i - 1].v) === a.rangeStatus) i--;
        a.outOfRangeMin = b.length ? (now - b[i].t) / MIN : 0;
      }
    }
  }
  return a;
}

export function analyzeAll(meta: CookMeta, samples: SampleRow[], now: number): ChannelAnalysis[] {
  return Object.keys(meta.channels)
    .sort()
    .map((id) => analyzeChannel(meta, samples, id, now))
    .filter((a) => a.role !== 'off');
}

/** Downsample a set of channels for charts/history (bucket averages). */
export function history(
  samples: SampleRow[],
  ids: string[],
  fromT: number,
  toT: number,
  bucketMs: number,
): { t: number[]; series: Record<string, (number | null)[]> } {
  const t: number[] = [];
  const series: Record<string, (number | null)[]> = Object.fromEntries(ids.map((id) => [id, []]));
  const start = Math.floor(fromT / bucketMs) * bucketMs;
  const sums = new Map<number, Record<string, [number, number]>>();
  for (let i = lowerBound(samples, start); i < samples.length; i++) {
    const row = samples[i];
    if (row.t > toT) break;
    const b = Math.floor(row.t / bucketMs) * bucketMs;
    let acc = sums.get(b);
    if (!acc) sums.set(b, (acc = {}));
    for (const id of ids) {
      const v = row.v[id];
      if (v == null) continue;
      const cell = (acc[id] ??= [0, 0]);
      cell[0] += v;
      cell[1]++;
    }
  }
  for (const b of [...sums.keys()].sort((x, y) => x - y)) {
    t.push(b);
    const acc = sums.get(b)!;
    for (const id of ids) {
      const cell = acc[id];
      series[id].push(cell ? Math.round((cell[0] / cell[1]) * 10) / 10 : null);
    }
  }
  return { t, series };
}
