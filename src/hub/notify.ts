import { execFile } from 'node:child_process';
import type { Config } from '../config.ts';
import type { Severity } from './store.ts';

export interface Notice {
  title: string;
  message: string;
  severity: Severity;
  /** Buzz the phone (ntfy) even for info-level notices. */
  push: boolean;
}

type Log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;

export class Notifier {
  private cfg: Config;
  private log: Log;

  constructor(cfg: Config, log: Log) {
    this.cfg = cfg;
    this.log = log;
  }

  send(n: Notice): void {
    const important = n.push || n.severity !== 'info';
    if (!important) return;
    if (process.platform === 'darwin' && this.cfg.desktopNotifications) this.macBanner(n);
    if (process.platform === 'darwin' && this.cfg.speak && n.severity === 'critical') this.say(n);
    if (this.cfg.ntfy.topic) void this.ntfy(n);
  }

  private macBanner(n: Notice): void {
    // Pass text via argv so quotes/emoji can't break the AppleScript.
    const script = [
      'on run argv',
      `display notification (item 2 of argv) with title "Smoke Signal" subtitle (item 1 of argv)${n.severity === 'info' ? '' : ' sound name "Glass"'}`,
      'end run',
    ];
    execFile('osascript', [...script.flatMap((l) => ['-e', l]), n.title, n.message], (err) => {
      if (err) this.log('debug', `macOS notification failed: ${err.message}`);
    });
  }

  private say(n: Notice): void {
    execFile('say', [n.title.replace(/°F/g, ' degrees').replace(/°C/g, ' degrees')], (err) => {
      if (err) this.log('debug', `say failed: ${err.message}`);
    });
  }

  private async ntfy(n: Notice): Promise<void> {
    try {
      const res = await fetch(this.cfg.ntfy.server.replace(/\/$/, ''), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          topic: this.cfg.ntfy.topic,
          title: n.title,
          message: n.message,
          priority: n.severity === 'critical' ? 5 : n.severity === 'warning' ? 4 : 3,
          tags: [n.severity === 'critical' ? 'rotating_light' : n.severity === 'warning' ? 'warning' : 'fire'],
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) this.log('warn', `ntfy push failed: HTTP ${res.status}`);
    } catch (err) {
      this.log('warn', `ntfy push failed: ${(err as Error).message}`);
    }
  }
}
