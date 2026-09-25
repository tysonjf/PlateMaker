// Live status block for the hub's terminal: log lines scroll above, a compact dashboard stays
// pinned at the bottom (TTY only; plain log lines otherwise).

import type { Hub } from './hub.ts';
import type { CookEvent } from './store.ts';
import { bucketize, channelSeries } from './analytics.ts';
import { fmtDuration, fmtRate, fmtTemp } from '../units.ts';
import { clock } from './report.ts';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = c('2');
const red = c('31');
const green = c('32');
const yellow = c('33');
const bold = c('1');
const cyan = c('36');

const SPARK = '▁▂▃▄▅▆▇█';

function sparkline(values: number[]): string {
  if (values.length < 2) return ''.padEnd(12);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return values.map((v) => SPARK[Math.min(7, Math.floor(((v - min) / span) * 7.999))]).join('').padEnd(12);
}

const visibleLength = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '').length;

function truncate(s: string, width: number): string {
  if (visibleLength(s) <= width) return s;
  // drop colour codes when we have to cut, simpler than cutting through escapes
  return s.replace(/\x1b\[[0-9;]*m/g, '').slice(0, Math.max(0, width - 1)) + '…';
}

export class TerminalUI {
  private hub: Hub;
  private url: string;
  private drawn = 0;
  private timer: NodeJS.Timeout | null = null;
  private lastAlarm: CookEvent | null = null;
  private verbose: boolean;
  private tty = !!process.stdout.isTTY;

  constructor(hub: Hub, url: string, verbose = false) {
    this.hub = hub;
    this.url = url;
    this.verbose = verbose;
  }

  attach(): void {
    this.hub.on('log', (level: string, msg: string) => {
      if (level === 'debug' && !this.verbose) return;
      const tag = level === 'error' ? red('✖') : level === 'warn' ? yellow('!') : dim('•');
      this.print(`${dim(clock(Date.now()))} ${tag} ${msg}`);
    });
    this.hub.on('event', (e: CookEvent) => {
      if (e.type === 'alarm' || e.source === 'claude') this.lastAlarm = e;
      const icon = e.source === 'claude' ? cyan('✦ Claude') : e.type === 'alarm' ? (e.severity === 'critical' ? red('▲ ALARM') : yellow('▲ Alarm')) : e.type === 'alarm-cleared' ? green('✓') : dim('•');
      this.print(`${dim(clock(e.at))} ${icon} ${e.title}${e.message && e.type !== 'alarm-cleared' ? dim(` — ${e.message}`) : ''}`);
    });
    if (this.tty) this.timer = setInterval(() => this.redraw(), 2000);
    else this.timer = setInterval(() => console.log(this.statusLines().join('\n')), 60_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.clear();
  }

  print(line: string): void {
    this.clear();
    process.stdout.write(line + '\n');
    this.draw();
  }

  private clear(): void {
    if (this.tty && this.drawn) process.stdout.write(`\x1b[${this.drawn}A\x1b[0J`);
    this.drawn = 0;
  }

  private draw(): void {
    if (!this.tty || !this.hub.store) return;
    const width = (process.stdout.columns || 100) - 1;
    const lines = this.statusLines().map((l) => truncate(l, width));
    process.stdout.write(lines.join('\n') + '\n');
    this.drawn = lines.length;
  }

  private redraw(): void {
    this.clear();
    this.draw();
  }

  statusLines(): string[] {
    const s = this.hub.snapshot();
    const unit = s.unit;
    const width = Math.min((process.stdout.columns || 100) - 1, 110);
    const cook = s.cook;
    const out: string[] = [dim('─'.repeat(width))];
    const cookTxt = cook.startedAt ? `${bold(cook.name)} · ${fmtDuration((cook.endedAt ?? s.now) - cook.startedAt)}` : dim('no cook started');
    const claude = s.claudeLastCheckAt ? `Claude checked ${fmtDuration(s.now - s.claudeLastCheckAt)} ago` : dim('Claude not connected yet');
    out.push(` 🔥 ${bold('Smoke Signal')} · ${cookTxt} · ${clock(s.now)}${s.mode === 'sim' ? yellow(` · SIMULATOR${s.speed !== 1 ? ` ×${s.speed}` : ''}`) : ''}   ${dim(this.url)}`);
    const ordered = [...s.analyses].sort((a, b) => (a.role === b.role ? a.id.localeCompare(b.id) : a.role === 'pit' ? -1 : 1));
    for (const a of ordered) {
      const pts = bucketize(channelSeries(this.hub.store.samples, a.id, s.now - 60 * 60_000, s.now), 5 * 60_000).map((p) => p.v);
      const pad = (plain: string, n: number) => ' '.repeat(Math.max(1, n - plain.length));
      const label = `${a.label} ${dim(a.id)}${pad(`${a.label} ${a.id}`, 22)}`;
      const tempText = a.current == null ? (a.sensorStatus === 'docked' ? 'docked' : '—') : fmtTemp(a.current, unit);
      const outOfRange = a.role === 'pit' && (a.rangeStatus === 'low' || a.rangeStatus === 'high');
      const temp = (a.current == null ? dim(tempText) : outOfRange ? red(tempText) : bold(tempText)) + pad(tempText, 8);
      let extra = '';
      if (a.role === 'pit') {
        const range = a.lowC != null || a.highC != null ? `${fmtTemp(a.lowC, unit)}–${fmtTemp(a.highC, unit)}` : 'no range';
        const st = a.rangeStatus === 'low' ? red(' LOW') : a.rangeStatus === 'high' ? red(' HIGH') : a.rangeStatus === 'ok' ? green(' ✓') : '';
        extra = `${dim(range)}${st}`;
      } else {
        extra = a.targetC != null ? dim(`→ ${fmtTemp(a.targetC, unit)}`) : dim('no target');
        if (a.stall) extra += yellow(` STALL ${fmtDuration(a.stall.minutes * 60_000)}`);
        if (a.targetC != null && a.current != null && a.current >= a.targetC) extra += green(' DONE');
      }
      out.push(` ${label}${temp}${dim(sparkline(pts))} ${extra}  ${dim(fmtRate(a.rate30, unit))}`);
    }
    if (!ordered.length) out.push(dim(' Waiting for thermometer data…'));
    const devs = s.devices
      .map((d) => `${d.connected ? green('●') : red('○')} ${d.alias} ${dim(`${d.model}${d.rssi != null ? ` ${d.rssi}dBm` : ''}${d.batteryPct != null ? ` batt ${d.batteryPct}%` : ''}`)}`)
      .join('   ');
    out.push(` ${devs || dim('No thermometer found yet')}   ${claude}`);
    if (this.lastAlarm) out.push(` ${dim('Last alert:')} ${this.lastAlarm.title} ${dim(clock(this.lastAlarm.at))}`);
    out.push(dim('─'.repeat(width)));
    return out;
  }
}
