// The compact, pre-digested text Claude reads on every check-in. Keep it short: a 12-hour cook
// with a check every 5 minutes means ~150 of these in one conversation.

import type { ChannelAnalysis } from './analytics.ts';
import type { HubSnapshot } from './hub.ts';
import type { CookEvent } from './store.ts';
import { fmtDiff, fmtDuration, fmtRate, fmtTemp, fmtWeight, deltaToUnit, type Unit } from '../units.ts';

const MIN = 60_000;

export function clock(t: number): string {
  return new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function dayClock(t: number, now: number): string {
  const d = new Date(t);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay ? clock(t) : `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${clock(t)}`;
}

export interface Flag {
  level: 'ACT' | 'WATCH' | 'INFO';
  text: string;
}

export function attentionFlags(s: HubSnapshot): Flag[] {
  const { unit, now, cook } = s;
  const flags: Flag[] = [];
  const t = (c: number | null | undefined) => fmtTemp(c, unit);
  for (const e of s.activeAlarms) {
    flags.push({ level: e.severity === 'info' ? 'WATCH' : 'ACT', text: `${e.title}${e.message ? ` — ${e.message}` : ''}` });
  }
  const pits = s.analyses.filter((a) => a.role === 'pit');
  const meats = s.analyses.filter((a) => a.role === 'meat');
  const cooking = cook.startedAt != null && cook.endedAt == null;

  for (const a of s.analyses) {
    if (a.current == null && a.lastAt != null && !s.activeAlarms.some((e) => e.channelId === a.id && e.code === 'signal_lost')) {
      flags.push({ level: cooking ? 'ACT' : 'INFO', text: `${a.label}: no reading for ${fmtDuration((a.ageSec ?? 0) * 1000)}` });
    }
  }
  for (const p of pits) {
    if (p.current == null || p.rate15 == null || p.rangeStatus !== 'ok') continue;
    if (s.activeAlarms.some((e) => e.channelId === p.id)) continue; // the alarm already says it
    if (p.lowC != null && p.rate15 < -8) {
      const mins = ((p.current - p.lowC) / -p.rate15) * 60;
      if (mins < 25) flags.push({ level: 'WATCH', text: `Pit falling ${fmtRate(p.rate15, unit)}; at this rate it drops below ${t(p.lowC)} in ~${Math.max(1, Math.round(mins))} min` });
    }
    if (p.highC != null && p.rate15 > 8) {
      const mins = ((p.highC - p.current) / p.rate15) * 60;
      if (mins < 25) flags.push({ level: 'WATCH', text: `Pit climbing ${fmtRate(p.rate15, unit)}; at this rate it passes ${t(p.highC)} in ~${Math.max(1, Math.round(mins))} min` });
    }
  }
  for (const m of meats) {
    if (m.current == null) continue;
    if (m.targetC == null) {
      if (cooking) flags.push({ level: 'INFO', text: `${m.label} has no target temperature set` });
      continue;
    }
    const left = m.targetC - m.current;
    if (left > 0 && left <= 5.5 && !s.activeAlarms.some((e) => e.channelId === m.id && e.code === 'near_target')) {
      flags.push({ level: 'WATCH', text: `${m.label} is ${fmtDiff(left, unit)} from target — start checking doneness soon` });
    }
    const eta = m.eta60Min ?? m.eta30Min;
    if (cook.serveAt && eta != null && !m.stall && left > 0) {
      const done = now + eta * MIN;
      if (done > cook.serveAt) {
        flags.push({ level: 'WATCH', text: `${m.label} projected done ~${clock(done)} (straight-line), after the ${clock(cook.serveAt)} serve time` });
      } else if (done > cook.serveAt - 60 * MIN) {
        flags.push({ level: 'WATCH', text: `${m.label} projected done ~${clock(done)}, leaving under 1h to rest before serving at ${clock(cook.serveAt)}` });
      }
    }
  }
  if (cooking && !pits.length) flags.push({ level: 'INFO', text: 'No pit/ambient sensor assigned — pit temperature is not being watched' });
  if (cooking && pits.length && pits.every((p) => p.lowC == null && p.highC == null)) {
    flags.push({ level: 'INFO', text: 'No pit temperature range set — pit alarms are off' });
  }
  return flags;
}

function channelLine(a: ChannelAnalysis, unit: Unit, now: number): string {
  const t = (c: number | null | undefined) => fmtTemp(c, unit);
  const head = `${a.role === 'pit' ? 'PIT ' : 'MEAT'} ${a.label} [${a.id}]`;
  if (a.current == null) {
    if (a.sensorStatus === 'docked') return `${head}: probe is in the base/charging dock (not measuring)`;
    if (a.sensorStatus === 'no-probe' && a.lastAt == null) return `${head}: no probe reading (probe not inserted/paired?)`;
    return a.lastAt == null
      ? `${head}: no data yet`
      : `${head}: NO SIGNAL for ${fmtDuration(now - a.lastAt)} (last reading ${clock(a.lastAt)}${a.sensorStatus && a.sensorStatus !== 'ok' ? `, device says: ${a.sensorStatus}` : ''})`;
  }
  const parts: string[] = [`${head}: ${fmtTemp(a.current, unit, 0)}`];
  if (a.role === 'pit') {
    if (a.lowC != null || a.highC != null) {
      const st = a.rangeStatus === 'ok' ? 'in range' : a.rangeStatus === 'low' ? `LOW for ${fmtDuration((a.outOfRangeMin ?? 0) * MIN)}` : a.rangeStatus === 'high' ? `HIGH for ${fmtDuration((a.outOfRangeMin ?? 0) * MIN)}` : '';
      parts.push(`range ${t(a.lowC)}–${t(a.highC)} ${st}`.trim());
    } else parts.push('no range set');
    if (a.stats10) parts.push(`10m avg ${t(a.stats10.mean)} ±${Math.round(deltaToUnit(a.stats10.std, unit))} (min ${t(a.stats10.min)}, max ${t(a.stats10.max)})`);
    parts.push(`trend ${fmtRate(a.rate15, unit)} (15m), ${fmtRate(a.rate60, unit)} (60m)`);
    const dips = (a.dips ?? []).filter((d) => now - d.at < 30 * MIN);
    if (dips.length) parts.push(`dips: ${dips.map((d) => `${clock(d.at)} −${fmtDiff(d.dropC, unit)}${d.recovered ? ' (recovered)' : ''}`).join(', ')}`);
  } else {
    if (a.targetC != null) {
      const left = a.targetC - a.current;
      parts.push(left > 0 ? `target ${t(a.targetC)} (${fmtDiff(left, unit)} to go)` : `target ${t(a.targetC)} REACHED`);
    } else parts.push('no target');
    parts.push(`rate ${fmtRate(a.rate15, unit)} (15m), ${fmtRate(a.rate30, unit)} (30m), ${fmtRate(a.rate60, unit)} (60m)`);
    if (a.stall) parts.push(`STALL since ${clock(a.stall.since)} (${fmtDuration(a.stall.minutes * MIN)})`);
    if (a.targetC != null && a.current < a.targetC) {
      const e30 = a.eta30Min;
      const e60 = a.eta60Min;
      if (a.stall) parts.push('ETA: unreliable during stall');
      else if (e30 != null || e60 != null) {
        const txt = [e30 != null ? `~${clock(now + e30 * MIN)} at 30m rate` : null, e60 != null ? `~${clock(now + e60 * MIN)} at 60m rate` : null]
          .filter(Boolean)
          .join(', ');
        parts.push(`ETA ${txt} (straight-line; ignores stall/wrap effects)`);
      } else parts.push('ETA: not rising yet');
    }
    if (a.crossed60At && a.crossed60At > 0) parts.push(`passed ${fmtTemp(60, unit)} at ${clock(a.crossed60At)}`);
  }
  return parts.join(' · ');
}

function eventLine(e: CookEvent, now: number): string {
  const who =
    e.type === 'claude' ? 'Claude alert' : e.type === 'note' ? 'Note' : e.type === 'alarm' ? `ALARM(${e.severity})` : e.type === 'alarm-cleared' ? 'Cleared' : 'Event';
  const ch = e.channelId && /^[A-Z]\d+$/.test(e.channelId) ? ` [${e.channelId}]` : '';
  return `- ${dayClock(e.at, now)} ${who}${ch}: ${e.title}${e.message && e.type !== 'alarm-cleared' ? ` — ${e.message}` : ''}`;
}

function briefChannel(a: ChannelAnalysis, unit: Unit, now: number): string {
  const t = (c: number | null | undefined) => (c == null ? '—' : Math.round(unit === 'F' ? (c * 9) / 5 + 32 : c).toString());
  if (a.current == null) {
    return `${a.label} ${a.id} ${a.sensorStatus === 'docked' ? 'docked' : a.lastAt ? `NO SIGNAL ${fmtDuration(now - a.lastAt)}` : 'no data'}`;
  }
  if (a.role === 'pit') {
    const range = a.lowC != null || a.highC != null ? `${t(a.lowC)}–${t(a.highC)} ${a.rangeStatus === 'ok' ? 'ok' : (a.rangeStatus ?? '').toUpperCase()}` : 'no range';
    return `${a.label} ${a.id} ${t(a.current)} (${range}; 30m ${fmtRate(a.rate30, unit)})`;
  }
  const bits = [`30m ${fmtRate(a.rate30, unit)}`];
  if (a.stall) bits.push(`STALL ${fmtDuration(a.stall.minutes * MIN)}`);
  else if (a.targetC != null && a.current < a.targetC && (a.eta60Min ?? a.eta30Min) != null) bits.push(`ETA ~${clock(now + (a.eta60Min ?? a.eta30Min)! * MIN)}`);
  if (a.targetC != null && a.current >= a.targetC) bits.push('TARGET REACHED');
  return `${a.label} ${a.id} ${t(a.current)}${a.targetC != null ? `→${t(a.targetC)}` : ''} (${bits.join('; ')})`;
}

/**
 * Compact check-in for when nothing needs attention (keeps long monitoring sessions cheap).
 * `detail: 'auto'` returns this only if there are no ACT/WATCH flags and no alarms since the last check.
 */
export function buildCheckIn(s: HubSnapshot, opts: { since?: number | null; detail?: 'auto' | 'brief' | 'full' } = {}): string {
  const detail = opts.detail ?? 'auto';
  const flags = attentionFlags(s);
  const since = opts.since ?? null;
  const recent = since ? s.recentEvents.filter((e) => e.at > since) : [];
  const needsFull =
    !since || flags.some((f) => f.level !== 'INFO') || recent.some((e) => e.type === 'alarm' || e.type === 'alarm-cleared');
  if (detail === 'full' || (detail === 'auto' && needsFull)) return buildReport(s, { since });
  const { unit, now, cook } = s;
  const ordered = [...s.analyses].sort((a, b) => (a.role === b.role ? a.id.localeCompare(b.id) : a.role === 'pit' ? -1 : 1));
  const head = `Check-in ${clock(now)}${since ? ` (prev ${clock(since)})` : ''} · ${cook.startedAt ? `${cook.name} ${fmtDuration(now - cook.startedAt)}` : 'no cook started'} · °${unit}${s.mode === 'sim' ? ' · SIMULATOR' : ''}`;
  const lines = [head, ordered.map((a) => briefChannel(a, unit, now)).join(' | ') || 'No sensors reporting'];
  const info = flags.filter((f) => f.level === 'INFO');
  lines.push(`Attention: ${info.length ? info.map((f) => f.text).join('; ') : 'none'}`);
  lines.push(`Events: ${recent.length ? recent.map((e) => `${clock(e.at)} ${e.type === 'claude' ? 'Claude alert' : e.type}: ${e.title}`).join('; ') : 'none'}`);
  const down = s.devices.filter((d) => !d.connected);
  if (down.length) lines.push(`Devices: ${down.map((d) => `${d.alias} DISCONNECTED (${d.state})`).join('; ')}`);
  lines.push('(brief — all nominal; call with detail="full" for trends/ETA detail)');
  return lines.join('\n');
}

export function buildReport(s: HubSnapshot, opts: { since?: number | null } = {}): string {
  const { unit, now, cook } = s;
  const lines: string[] = [];
  const mode = s.mode === 'sim' ? ` · SIMULATOR${s.speed !== 1 ? ` ×${s.speed}` : ''}` : '';
  lines.push(`Smoke Signal check-in — ${dayClock(now, now)} · units °${unit}${mode}`);

  const desc = [cook.meat, fmtWeight(cook.weightKg, unit), cook.method].filter(Boolean).join(', ');
  if (cook.startedAt != null) {
    const ended = cook.endedAt != null ? ` · ENDED ${dayClock(cook.endedAt, now)}` : '';
    lines.push(`Cook: "${cook.name}"${desc ? ` (${desc})` : ''} · on since ${dayClock(cook.startedAt, now)} (${fmtDuration((cook.endedAt ?? now) - cook.startedAt)})${ended}`);
  } else {
    lines.push(`Cook: not started yet${desc ? ` (${desc})` : ''} — call start_cook once the meat is on`);
  }
  const goal = [cook.goal, cook.serveAt ? `serve at ${dayClock(cook.serveAt, now)}` : null].filter(Boolean).join(' · ');
  if (goal) lines.push(`Goal: ${goal}`);
  if (opts.since) lines.push(`Previous check: ${dayClock(opts.since, now)} (${fmtDuration(now - opts.since)} ago)`);

  lines.push('');
  const ordered = [...s.analyses].sort((a, b) => (a.role === b.role ? a.id.localeCompare(b.id) : a.role === 'pit' ? -1 : 1));
  if (!ordered.length) lines.push('No sensors reporting yet. Check the hub terminal: are the thermometers on and in range?');
  for (const a of ordered) lines.push(channelLine(a, unit, now));

  const flags = attentionFlags(s);
  lines.push('');
  if (flags.length) {
    lines.push('Attention:');
    for (const f of flags) lines.push(`- [${f.level}] ${f.text}`);
  } else {
    lines.push('Attention: none — all readings nominal.');
  }

  const since = opts.since ?? now - 15 * MIN;
  const recent = s.recentEvents.filter((e) => e.at > since);
  lines.push('');
  if (recent.length) {
    lines.push(`Events since ${clock(since)}:`);
    for (const e of recent.slice(-15)) lines.push(eventLine(e, now));
  } else {
    lines.push(`Events since ${clock(since)}: none`);
  }

  const devs = s.devices.map(
    (d) =>
      `${d.alias} [${d.letter}] ${d.model} ${d.connected ? 'connected' : `DISCONNECTED (${d.state})`}` +
      (d.batteryPct != null ? `, battery ${d.batteryPct}%` : '') +
      (d.rssi != null ? `, signal ${d.rssi} dBm` : ''),
  );
  lines.push('');
  lines.push(`Devices: ${devs.length ? devs.join(' · ') : 'none found yet'}`);
  return lines.join('\n');
}
