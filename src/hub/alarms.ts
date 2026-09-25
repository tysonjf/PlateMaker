// Deterministic safety-net alarms. These fire even if no Claude session is watching.

import type { ChannelAnalysis } from './analytics.ts';
import { channelSeries, bucketize } from './analytics.ts';
import type { CookEvent, CookMeta, SampleRow, Severity } from './store.ts';
import type { DeviceStatus } from '../devices/types.ts';
import { fmtTemp, fmtDiff, fmtRate, fmtDuration, type Unit } from '../units.ts';

export interface AlarmInput {
  meta: CookMeta;
  samples: SampleRow[];
  analyses: ChannelAnalysis[];
  devices: DeviceStatus[];
  now: number;
  unit: Unit;
}

export interface RaisedAlarm {
  type: 'alarm' | 'alarm-cleared' | 'system';
  code: string;
  channelId?: string;
  severity: Severity;
  title: string;
  message: string;
  /** Worth buzzing the user's phone. */
  push: boolean;
  ref?: number;
}

interface Condition {
  key: string;
  code: string;
  channelId?: string;
  active: boolean;
  severity: Severity;
  title: string;
  message: string;
  push: boolean;
  /** Condition must hold this long before alarming. */
  holdMs: number;
  /** Re-alert interval while still active (null = alert once). */
  renotifyMs: number | null;
  /** Title for the "back to normal" event, if worth announcing. */
  clearedTitle?: string;
}

interface State {
  firstTrueAt: number;
  raisedAt?: number;
  lastNotifiedAt?: number;
}

const MIN = 60_000;

export class AlarmEngine {
  private state = new Map<string, State>();
  private seenOnce = new Set<string>();
  private reportedDips: number[] = [];
  private pitArmed = new Map<string, boolean>();

  /** Rebuild state from the event log so a hub restart doesn't re-fire one-shot alarms. */
  restore(events: CookEvent[]): void {
    for (const e of events) {
      const key = `${e.code}:${e.channelId ?? ''}`;
      if (e.type === 'alarm' && e.code) {
        this.state.set(key, { firstTrueAt: e.at, raisedAt: e.at, lastNotifiedAt: e.at });
      } else if (e.type === 'alarm-cleared' && e.code) {
        this.state.delete(key);
      } else if (e.type === 'system' && e.code === 'stall' && e.ref != null) {
        this.seenOnce.add(`stall:${e.channelId ?? ''}:${new Date(e.ref).toISOString()}`);
      } else if (e.type === 'system' && e.code === 'lid_open' && e.ref != null) {
        this.reportedDips.push(e.ref);
      }
    }
  }

  isActive(code: string, channelId?: string): boolean {
    return this.state.get(`${code}:${channelId ?? ''}`)?.raisedAt != null;
  }

  activeAlarms(): string[] {
    return [...this.state.entries()].filter(([, s]) => s.raisedAt != null).map(([k]) => k);
  }

  evaluate(input: AlarmInput): RaisedAlarm[] {
    const out: RaisedAlarm[] = [];
    const { now } = input;
    for (const c of this.conditions(input)) {
      let st = this.state.get(c.key);
      if (c.active) {
        if (!st) this.state.set(c.key, (st = { firstTrueAt: now }));
        const due =
          st.raisedAt == null
            ? now - st.firstTrueAt >= c.holdMs
            : c.renotifyMs != null && now - (st.lastNotifiedAt ?? st.raisedAt) >= c.renotifyMs;
        if (due) {
          const repeat = st.raisedAt != null;
          st.raisedAt ??= now;
          st.lastNotifiedAt = now;
          out.push({
            type: 'alarm',
            code: c.code,
            channelId: c.channelId,
            severity: c.severity,
            title: repeat ? `Still: ${c.title}` : c.title,
            message: c.message,
            push: c.push,
          });
        }
      } else if (st) {
        if (st.raisedAt != null && c.clearedTitle) {
          out.push({
            type: 'alarm-cleared',
            code: c.code,
            channelId: c.channelId,
            severity: 'info',
            title: c.clearedTitle,
            message: c.message,
            push: false,
          });
        }
        this.state.delete(c.key);
      }
    }
    out.push(...this.oneShots(input));
    return out;
  }

  private isPitArmed(input: AlarmInput, a: ChannelAnalysis): boolean {
    // Pit alarms only arm once the pit has actually come up to the target range, so the
    // warm-up at the start of a cook doesn't trigger "pit too low".
    if (this.pitArmed.get(a.id)) return true;
    const since = input.meta.startedAt ?? input.meta.createdAt;
    const pts = bucketize(channelSeries(input.samples, a.id, since, input.now), MIN);
    const inRange = pts.some((p) => (a.lowC == null || p.v >= a.lowC) && (a.highC == null || p.v <= a.highC));
    if (inRange) this.pitArmed.set(a.id, true);
    return inRange;
  }

  private conditions(input: AlarmInput): Condition[] {
    const { meta, analyses, unit, now } = input;
    const t = (c: number | null | undefined) => fmtTemp(c, unit);
    const cooking = meta.startedAt != null && meta.endedAt == null;
    const out: Condition[] = [];
    const pit = analyses.find((a) => a.role === 'pit' && a.current != null);

    for (const a of analyses) {
      const key = (code: string) => `${code}:${a.id}`;

      // --- signal loss (any channel that used to report; a probe put back in its dock is deliberate) ---
      if (cooking && a.lastAt != null && a.lastAt >= (meta.startedAt ?? 0) && a.sensorStatus !== 'docked') {
        const silentMs = now - a.lastAt;
        const active = silentMs > 2 * MIN;
        out.push({
          key: key('signal_lost'),
          code: 'signal_lost',
          channelId: a.id,
          active,
          severity: 'warning',
          title: `Lost signal: ${a.label}`,
          message: `No reading from ${a.label} for ${fmtDuration(silentMs)} (last ${t(a.lastAt ? lastValue(input, a.id) : null)}). Check the probe/booster is within range and charged.`,
          push: true,
          holdMs: 0,
          renotifyMs: 30 * MIN,
          clearedTitle: `${a.label} is reporting again`,
        });
      }

      if (a.role === 'meat' && a.targetC != null && a.current != null) {
        const reachedActive = this.isActive('target_reached', a.id);
        out.push({
          key: key('target_reached'),
          code: 'target_reached',
          channelId: a.id,
          active: reachedActive ? a.current >= a.targetC - 3 : a.current >= a.targetC,
          severity: 'critical',
          title: `${a.label} hit ${t(a.targetC)}`,
          message: `${a.label} is at ${t(a.current)} (target ${t(a.targetC)}). Check tenderness and pull it to rest.`,
          push: true,
          holdMs: 20_000,
          renotifyMs: null,
        });
        const nearActive = this.isActive('near_target', a.id);
        out.push({
          key: key('near_target'),
          code: 'near_target',
          channelId: a.id,
          active: nearActive ? a.current >= a.targetC - 6 : a.current >= a.targetC - 3 && a.current < a.targetC,
          severity: 'info',
          title: `${a.label} is almost done`,
          message: `${a.label} is ${t(a.current)} — ${fmtDiff(a.targetC - a.current, unit)} short of the ${t(a.targetC)} target. Start checking for doneness.`,
          push: true,
          holdMs: 30_000,
          renotifyMs: null,
        });
      }

      if (a.role === 'meat' && cooking && a.current != null && a.current > 40 && !this.isActive('target_reached', a.id)) {
        const falling = a.rate30 != null && a.rate30 < -3 && a.peakC != null && a.current < a.peakC - 3;
        out.push({
          key: key('meat_falling'),
          code: 'meat_falling',
          channelId: a.id,
          active: this.isActive('meat_falling', a.id) ? (a.rate30 ?? 0) < -1 : falling,
          severity: 'warning',
          title: `${a.label} temperature is falling`,
          message: `${a.label} dropped to ${t(a.current)} (${fmtRate(a.rate30, unit)} over 30 min, peak ${t(a.peakC)}). Probe may have shifted, the meat may be out of the heat, or the pit is too cool.`,
          push: true,
          holdMs: 5 * MIN,
          renotifyMs: 60 * MIN,
          clearedTitle: `${a.label} is climbing again`,
        });
      }

      if (a.role === 'meat' && pit && pit.current != null && a.current != null && cooking) {
        out.push({
          key: key('meat_above_pit'),
          code: 'meat_above_pit',
          channelId: a.id,
          active: a.current > pit.current + 8,
          severity: 'info',
          title: `${a.label} reads hotter than the pit`,
          message: `${a.label} ${t(a.current)} vs pit ${t(pit.current)}. The probe may be out of the meat, touching bone/metal, or the pit sensor is shaded.`,
          push: false,
          holdMs: 5 * MIN,
          renotifyMs: null,
        });
      }

      if (a.role === 'pit' && a.current != null && (a.lowC != null || a.highC != null) && this.isPitArmed(input, a)) {
        const s3 = a.stats10;
        const low = a.lowC;
        const high = a.highC;
        const lowActive = this.isActive('pit_low', a.id);
        const isLow = low != null && (lowActive ? a.current < low + 1 : a.rangeStatus === 'low');
        const veryLow = low != null && a.current < low - 25;
        out.push({
          key: key('pit_low'),
          code: 'pit_low',
          channelId: a.id,
          active: isLow,
          severity: veryLow ? 'critical' : 'warning',
          title: veryLow ? `Pit is way too cool — fire may be going out` : `Pit running low`,
          message: `Pit is ${t(a.current)}, below your ${t(low)}–${t(high)} range for ${fmtDuration((a.outOfRangeMin ?? 0) * MIN)} (${fmtRate(a.rate15, unit)} over 15 min).`,
          push: true,
          holdMs: 10 * MIN,
          renotifyMs: 20 * MIN,
          clearedTitle: `Pit back in range (${t(a.current)})`,
        });
        const highActive = this.isActive('pit_high', a.id);
        const isHigh = high != null && (highActive ? a.current > high - 1 : a.rangeStatus === 'high');
        const veryHigh = high != null && a.current > high + 30;
        out.push({
          key: key('pit_high'),
          code: 'pit_high',
          channelId: a.id,
          active: isHigh,
          severity: veryHigh ? 'critical' : 'warning',
          title: veryHigh ? `Pit is way too hot` : `Pit running hot`,
          message: `Pit is ${t(a.current)}, above your ${t(low)}–${t(high)} range for ${fmtDuration((a.outOfRangeMin ?? 0) * MIN)}${s3 ? ` (10-min avg ${t(s3.mean)})` : ''}.`,
          push: true,
          holdMs: veryHigh ? 2 * MIN : 5 * MIN,
          renotifyMs: 20 * MIN,
          clearedTitle: `Pit back in range (${t(a.current)})`,
        });
        const fallingActive = this.isActive('pit_falling', a.id);
        const falling = fallingActive
          ? (a.rate15 ?? 0) < -5
          : a.rate30 != null && a.rate30 < -20 && a.rate15 != null && a.rate15 < -10 && !(a.dips ?? []).some((d) => now - d.at < 15 * MIN);
        out.push({
          key: key('pit_falling'),
          code: 'pit_falling',
          channelId: a.id,
          active: falling,
          severity: 'warning',
          title: `Pit temperature falling steadily`,
          message: `Pit ${t(a.current)} and dropping (${fmtRate(a.rate30, unit)} over 30 min). Fire may need fuel or air.`,
          push: true,
          holdMs: 3 * MIN,
          renotifyMs: 30 * MIN,
          clearedTitle: `Pit temperature has stabilised`,
        });
      }
    }

    for (const d of input.devices) {
      if (d.batteryPct == null) continue;
      const active = this.isActive('battery_low', d.id) ? d.batteryPct < 25 : d.batteryPct < 15;
      out.push({
        key: `battery_low:${d.id}`,
        code: 'battery_low',
        channelId: d.id,
        active,
        severity: 'warning',
        title: `Battery low: ${d.name}`,
        message: `${d.name} battery at ${d.batteryPct}%. Charge it before the next long cook (or now, if it's a probe that can go back in its charger).`,
        push: true,
        holdMs: MIN,
        renotifyMs: null,
      });
    }
    return out;
  }

  /** Informational one-off events (stall started, lid opened…), deduplicated forever. */
  private oneShots(input: AlarmInput): RaisedAlarm[] {
    const out: RaisedAlarm[] = [];
    const { analyses, unit } = input;
    const once = (code: string, channelId: string, tag: string, ev: Omit<RaisedAlarm, 'type' | 'code' | 'channelId'>) => {
      const k = `${code}:${channelId}:${tag}`;
      if (this.seenOnce.has(k)) return;
      this.seenOnce.add(k);
      out.push({ type: 'system', code, channelId, ...ev });
    };
    for (const a of analyses) {
      if (a.role === 'meat' && a.stall) {
        const tag = new Date(a.stall.since).toISOString();
        // one stall announcement per ~2h window per probe
        const already = [...this.seenOnce].some((k) => {
          if (!k.startsWith(`stall:${a.id}:`)) return false;
          const at = Date.parse(k.slice(`stall:${a.id}:`.length));
          return Math.abs(at - a.stall!.since) < 2 * 3600_000;
        });
        if (!already) {
          once('stall', a.id, tag, {
            severity: 'info',
            title: `${a.label} is in the stall`,
            message: `${a.label} has hovered around ${fmtTemp(a.current, unit)} for ${fmtDuration(a.stall.minutes * MIN)}. Normal for big cuts; wrap or ride it out.`,
            push: false,
            ref: a.stall.since,
          });
        }
      }
      if (a.role === 'pit') {
        for (const d of a.dips ?? []) {
          // Only fresh dips, and each dip once even as the analysis window slides over it.
          if (input.now - d.lowAt > 15 * MIN || this.reportedDips.some((t) => Math.abs(t - d.lowAt) < 5 * MIN)) continue;
          this.reportedDips.push(d.lowAt);
          once('lid_open', a.id, String(d.lowAt), {
            severity: 'info',
            title: `Pit dipped ${fmtDiff(d.dropC, unit)}`,
            message: `Sharp ${d.recovered ? 'dip and recovery' : 'drop'} at ${new Date(d.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} — lid opened / spritz / fuel added?`,
            push: false,
            ref: d.lowAt,
          });
        }
      }
    }
    return out;
  }
}

function lastValue(input: AlarmInput, id: string): number | null {
  for (let i = input.samples.length - 1; i >= 0; i--) {
    const v = input.samples[i].v[id];
    if (v != null) return v;
  }
  return null;
}
