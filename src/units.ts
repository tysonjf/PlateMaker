// Everything inside Smoke Signal is stored in °C. Conversion happens only at the edges
// (terminal, dashboard, reports for Claude) using the user's preferred unit.

export type Unit = 'F' | 'C';

export const cToF = (c: number): number => (c * 9) / 5 + 32;
export const fToC = (f: number): number => ((f - 32) * 5) / 9;

/** Convert an absolute temperature from °C to the display unit. */
export function toUnit(c: number, unit: Unit): number {
  return unit === 'F' ? cToF(c) : c;
}

/** Convert an absolute temperature in the given unit to °C. */
export function fromUnit(value: number, unit: Unit): number {
  return unit === 'F' ? fToC(value) : value;
}

/** Convert a temperature *difference* (e.g. a rate in °C/hr) to the display unit. */
export function deltaToUnit(dc: number, unit: Unit): number {
  return unit === 'F' ? (dc * 9) / 5 : dc;
}

export function deltaFromUnit(d: number, unit: Unit): number {
  return unit === 'F' ? (d * 5) / 9 : d;
}

export function fmtTemp(c: number | null | undefined, unit: Unit, digits = 0): string {
  if (c == null || !Number.isFinite(c)) return '—';
  return `${toUnit(c, unit).toFixed(digits)}°${unit}`;
}

export function fmtDelta(dc: number | null | undefined, unit: Unit, digits = 0): string {
  if (dc == null || !Number.isFinite(dc)) return '—';
  const v = deltaToUnit(dc, unit);
  const sign = v > 0 ? '+' : v < 0 ? '−' : '±';
  return `${sign}${Math.abs(v).toFixed(digits)}°${unit}`;
}

/** Unsigned temperature difference, e.g. "5°F". */
export function fmtDiff(dc: number | null | undefined, unit: Unit, digits = 0): string {
  if (dc == null || !Number.isFinite(dc)) return '—';
  return `${Math.abs(deltaToUnit(dc, unit)).toFixed(digits)}°${unit}`;
}

export function fmtRate(dcPerHour: number | null | undefined, unit: Unit): string {
  if (dcPerHour == null || !Number.isFinite(dcPerHour)) return '—';
  return `${fmtDelta(dcPerHour, unit, Math.abs(deltaToUnit(dcPerHour, unit)) < 10 ? 1 : 0)}/hr`;
}

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  const neg = ms < 0;
  let m = Math.round(Math.abs(ms) / 60000);
  const h = Math.floor(m / 60);
  m -= h * 60;
  const s = h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
  return neg ? `-${s}` : s;
}

export function kgFrom(value: number, unit: 'lb' | 'kg'): number {
  return unit === 'lb' ? value * 0.45359237 : value;
}

export function fmtWeight(kg: number | undefined, unit: Unit): string {
  if (kg == null) return '';
  return unit === 'F' ? `${(kg / 0.45359237).toFixed(1)} lb` : `${kg.toFixed(2)} kg`;
}
