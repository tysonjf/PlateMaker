// MCP server (stdio) that lets Claude read and steer the Smoke Signal hub.
//
// Deliberately contains NO Bluetooth code: Claude Desktop / Claude Code spawn this process, and
// macOS attributes a child's Bluetooth use to the parent app. The hub (run from Terminal) owns
// Bluetooth; this server just talks to it over http://127.0.0.1.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { hubUrl } from '../config.ts';
import { fmtTemp, type Unit } from '../units.ts';

const VERSION = '0.1.0';

const INSTRUCTIONS = `Smoke Signal connects you to the user's Bluetooth BBQ thermometers via a hub running on their Mac.
Typical Inkbird INT-12-BW channels: A1 = black probe tip (meat), A2 = black probe ambient (pit/smoker air temperature), A3 = white probe tip (meat). Channel ids, labels and roles are shown in every report.
- get_cook_report is the check-in tool: current temps, rate of rise, stall detection, ETA, pit stability, alarms and events since your last check, pre-computed.
- When the user wants their cook monitored, set it up with start_cook (targets + pit range), then check in every 5–10 minutes (in Claude Code: /loop). Keep all-clear check-ins to one short line; when the user must act, say exactly what to do and call send_alert so their phone/Mac buzzes.
- Record what the user tells you they did (wrapped, spritzed, added fuel, opened lid…) with log_event; it explains curve changes later.
- If the pitmaster skill is available, follow it for the detailed check-in protocol and BBQ guidance.`;

class HubDown extends Error {}

export async function runMcpServer(opts: { channel: boolean }): Promise<void> {
  const base = hubUrl();
  let lastCheck: number | null = null;

  async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw new HubDown(
        `The Smoke Signal hub isn't running (nothing answering at ${base}). Ask the user to start it on their Mac: ` +
          'open Terminal, `cd` into the smoke-signal folder and run `pnpm start` (or `pnpm sim` to try the simulator). ' +
          'It must run in its own Terminal window so macOS lets it use Bluetooth.',
      );
    }
    const ct = res.headers.get('content-type') ?? '';
    const data = ct.includes('json') ? await res.json() : await res.text();
    if (!res.ok) throw new Error(typeof data === 'object' && data && 'error' in data ? String((data as { error: unknown }).error) : String(data));
    return data as T;
  }

  const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
  const guard =
    <A,>(fn: (args: A) => Promise<{ content: { type: 'text'; text: string }[] }>) =>
    async (args: A) => {
      try {
        return await fn(args);
      } catch (err) {
        return { ...text(err instanceof HubDown ? err.message : `Smoke Signal error: ${(err as Error).message}`), isError: true };
      }
    };

  async function report(since?: number | null, detail: 'auto' | 'brief' | 'full' = 'full'): Promise<string> {
    const r = await api<{ now: number; text: string }>(`/api/report?client=claude&format=json&detail=${detail}${since ? `&since=${since}` : ''}`);
    lastCheck = r.now;
    return r.text;
  }

  const server = new McpServer(
    { name: 'smoke-signal', version: VERSION },
    {
      capabilities: opts.channel ? { experimental: { 'claude/channel': {} } } : {},
      instructions:
        INSTRUCTIONS +
        (opts.channel
          ? '\nUrgent hub alarms also arrive as <channel source="smoke-signal"> messages: treat each as an immediate check-in (call get_cook_report, then advise and alert).'
          : ''),
    },
  );

  const probeSchema = z.object({
    channel: z.string().describe('Channel id from the report, e.g. "A1", "A2", "A3"'),
    label: z.string().optional().describe('Friendly name, e.g. "Brisket flat", "Pork butt", "Pit"'),
    role: z.enum(['meat', 'pit', 'off']).optional().describe('meat = in the food, pit = smoker air temperature, off = ignore'),
    target: z.number().optional().describe('Meat: pull temperature, in `unit`'),
    low: z.number().optional().describe('Pit: lowest acceptable temperature, in `unit`'),
    high: z.number().optional().describe('Pit: highest acceptable temperature, in `unit`'),
  });

  const cookFields = {
    name: z.string().optional().describe('Short cook name, e.g. "Saturday brisket"'),
    meat: z.string().optional().describe('Cut and style, e.g. "whole packer brisket, prime"'),
    weight: z.number().optional(),
    weight_unit: z.enum(['lb', 'kg']).optional(),
    method: z.string().optional().describe('Cooker and fuel, e.g. "offset, post oak" or "pellet grill"'),
    goal: z.string().optional().describe('What the user wants, e.g. "sliced for dinner at 6pm, hold in cooler"'),
    serve_at: z.string().optional().describe('When they want to eat, ISO 8601 local time (e.g. "2026-09-26T18:00")'),
    probes: z.array(probeSchema).optional().describe('Per-channel labels, roles, targets and ranges'),
    pit_low: z.number().optional().describe('Shortcut: low end of the pit range for every pit channel, in `unit`'),
    pit_high: z.number().optional().describe('Shortcut: high end of the pit range for every pit channel, in `unit`'),
    unit: z.enum(['F', 'C']).optional().describe("Unit of the temperatures you pass (defaults to the user's display unit shown in reports)"),
  };

  type CookArgs = {
    name?: string;
    meat?: string;
    weight?: number;
    weight_unit?: 'lb' | 'kg';
    method?: string;
    goal?: string;
    serve_at?: string;
    probes?: z.infer<typeof probeSchema>[];
    pit_low?: number;
    pit_high?: number;
    unit?: 'F' | 'C';
  };

  async function cookBody(a: CookArgs): Promise<Record<string, unknown>> {
    const channels: Record<string, Record<string, unknown>> = {};
    for (const p of a.probes ?? []) {
      const c: Record<string, unknown> = {};
      if (p.label !== undefined) c.label = p.label;
      if (p.role !== undefined) c.role = p.role;
      if (p.target !== undefined) c.target = p.target;
      if (p.low !== undefined) c.low = p.low;
      if (p.high !== undefined) c.high = p.high;
      channels[p.channel.toUpperCase()] = c;
    }
    if (a.pit_low !== undefined || a.pit_high !== undefined) {
      const status = await api<{ analyses: { id: string; role: string }[]; cook: { channels: Record<string, { kind: string }> } }>('/api/status');
      const pits = Object.entries(status.cook.channels)
        .filter(([id, info]) => {
          const explicit = channels[id]?.role;
          const current = status.analyses.find((x) => x.id === id)?.role;
          return explicit ? explicit === 'pit' : current ? current === 'pit' : info.kind === 'ambient';
        })
        .map(([id]) => id);
      if (!pits.length) throw new Error('No pit/ambient channel found to apply pit_low/pit_high to. Assign one with probes: [{ channel, role: "pit" }].');
      for (const id of pits) {
        channels[id] ??= {};
        if (a.pit_low !== undefined) channels[id].low = a.pit_low;
        if (a.pit_high !== undefined) channels[id].high = a.pit_high;
      }
    }
    let serveAt: number | undefined;
    if (a.serve_at) {
      serveAt = Date.parse(a.serve_at);
      if (!Number.isFinite(serveAt)) throw new Error(`Couldn't parse serve_at "${a.serve_at}" — use ISO 8601 like 2026-09-26T18:00`);
    }
    return {
      name: a.name,
      meat: a.meat,
      weight: a.weight,
      weightUnit: a.weight_unit,
      method: a.method,
      goal: a.goal,
      serveAt,
      unit: a.unit,
      channels,
    };
  }

  server.registerTool(
    'get_cook_report',
    {
      title: 'Get cook report',
      description:
        'Check on the cook: pit and meat temperatures with 15/30/60-minute trends, stall detection, ETA to target, pit stability and dips, active alarms, and everything that happened since your previous check. Call this at every check-in.',
      inputSchema: {
        detail: z
          .enum(['auto', 'brief', 'full'])
          .optional()
          .describe('auto (default): a 4-line brief when everything is nominal, the full report whenever something needs attention; full: always the detailed report'),
        since: z.string().optional().describe('ISO time to list events from; defaults to your previous check-in'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async ({ since, detail = 'auto' }: { since?: string; detail?: 'auto' | 'brief' | 'full' }) =>
      text(await report(since ? Date.parse(since) : lastCheck, detail)),
    ),
  );

  server.registerTool(
    'get_temperature_history',
    {
      title: 'Get temperature history',
      description:
        'Temperature curve as a compact table (bucket averages) for looking at the shape of the cook: when the stall began, how the pit behaved overnight, what happened after wrapping.',
      inputSchema: {
        minutes: z.number().int().min(10).max(2880).optional().describe('How far back to look (default 180)'),
        bucket_minutes: z.number().int().min(1).max(120).optional().describe('Row spacing (default: ~40 rows)'),
        channels: z.array(z.string()).optional().describe('Channel ids to include (default all)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async ({ minutes = 180, bucket_minutes, channels }: { minutes?: number; bucket_minutes?: number; channels?: string[] }) => {
      const bucket = bucket_minutes ?? Math.max(1, Math.round(minutes / 40));
      const q = new URLSearchParams({ minutes: String(minutes), bucketSeconds: String(bucket * 60) });
      if (channels?.length) q.set('channels', channels.join(','));
      const h = await api<{ unit: Unit; t: number[]; series: Record<string, (number | null)[]>; labels: Record<string, string> }>(`/api/history?${q}`);
      const ids = Object.keys(h.series);
      if (!h.t.length || !ids.length) return text('No readings recorded in that window.');
      const time = (t: number) => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      const lines = [`time | ${ids.map((id) => `${h.labels[id] ?? id} [${id}]`).join(' | ')}`];
      h.t.forEach((t, i) => lines.push(`${time(t)} | ${ids.map((id) => fmtTemp(h.series[id][i], h.unit)).join(' | ')}`));
      return text(`Temperatures in °${h.unit}, ${bucket}-minute averages:\n${lines.join('\n')}`);
    }),
  );

  server.registerTool(
    'start_cook',
    {
      title: 'Start a cook',
      description:
        "Set up and start a cook: name, meat, weight, cooker, goal/serve time, and per-probe labels, meat target temperatures and the pit range (these arm the hub's own alarms). Pass new_cook=true to start a fresh log if a previous cook is in progress. Returns the first report.",
      inputSchema: {
        ...cookFields,
        name: z.string().describe('Short cook name, e.g. "Saturday brisket"'),
        new_cook: z.boolean().optional().describe('Start a fresh cook log instead of continuing the current one'),
        started_at: z.string().optional().describe('If the meat went on earlier, when (ISO 8601)'),
      },
    },
    guard(async (a: CookArgs & { name: string; new_cook?: boolean; started_at?: string }) => {
      const body = { ...(await cookBody(a)), newSession: a.new_cook === true, startedAt: a.started_at };
      await api('/api/cook/start', body);
      return text(`Cook started.\n\n${await report(lastCheck)}`);
    }),
  );

  server.registerTool(
    'update_cook',
    {
      title: 'Update the cook',
      description: 'Change cook details, probe labels/roles, meat targets or the pit range mid-cook (e.g. after the user raises the pit temperature or wraps).',
      inputSchema: cookFields,
    },
    guard(async (a: CookArgs) => {
      await api('/api/cook', await cookBody(a));
      return text(`Updated.\n\n${await report(lastCheck)}`);
    }),
  );

  server.registerTool(
    'log_event',
    {
      title: 'Log a cook event',
      description:
        'Record something that happened, as the user reports it: "wrapped in butcher paper", "spritzed", "added 2 splits of oak", "opened lid to check", "moved to oven", "probe repositioned". Shows on the graph and explains later curve changes.',
      inputSchema: { text: z.string().min(1).max(300) },
    },
    guard(async ({ text: note }: { text: string }) => {
      await api('/api/notes', { text: note, source: 'claude' });
      return text(`Logged: ${note}`);
    }),
  );

  server.registerTool(
    'send_alert',
    {
      title: 'Alert the user',
      description:
        "Buzz the user: macOS notification with sound on the Mac, a push to their phone if they set up ntfy, and an entry on the dashboard. Use when they need to act soon (fire dying, pit way off, meat nearly done, probe problem). Don't use for routine all-good updates. Title ≤ 60 chars; message = the concrete action.",
      inputSchema: {
        title: z.string().min(1).max(120),
        message: z.string().max(1000),
        severity: z.enum(['info', 'warning', 'critical']).optional().describe('critical = act now; warning = within ~15 min; info = heads-up'),
      },
    },
    guard(async ({ title, message, severity = 'warning' }: { title: string; message: string; severity?: 'info' | 'warning' | 'critical' }) => {
      await api('/api/alert', { title, message, severity });
      return text(`Alert sent (${severity}): ${title}`);
    }),
  );

  server.registerTool(
    'end_cook',
    {
      title: 'End the cook',
      description: 'Mark the cook finished (meat is off and resting / served). Hub alarms for this cook stop. Optionally store a short summary for next time.',
      inputSchema: { summary: z.string().max(2000).optional().describe('What went well / what to change next time') },
    },
    guard(async ({ summary }: { summary?: string }) => {
      await api('/api/cook/end', { summary });
      return text(`Cook ended.\n\n${await report(null)}`);
    }),
  );

  server.registerPrompt(
    'check_in',
    {
      title: 'Smoke Signal check-in',
      description: 'Check the smoker and meat now and advise',
    },
    () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              'Smoke Signal check-in. Call get_cook_report. If everything is on track reply with ONE short line (time, pit, each meat temp + trend). ' +
              'If something needs attention, lead with what to do and why in 2-4 sentences, and call send_alert for anything the user should act on within ~15 minutes. ' +
              "Don't repeat advice you already gave unless the situation changed.",
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'monitor_cook',
    {
      title: 'Monitor my cook',
      description: 'Set up a cook and start regular check-ins',
      argsSchema: { details: z.string().optional().describe('What you are cooking, weight, cooker, target, serve time') },
    },
    ({ details }: { details?: string }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `I want you to babysit my cook with Smoke Signal. ${details ?? ''}\n` +
              '1) Call get_cook_report to see which probes are connected. 2) Ask me only for what you still need (meat, weight, pit target), suggest sensible targets, then call start_cook. ' +
              '3) Tell me how check-ins will run: in Claude Code use /loop 5m /pitmaster check (or Claude sets it up); in Claude Desktop chat, send "check" any time.',
          },
        },
      ],
    }),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  if (opts.channel) void forwardAlarms(base, server);
}

/** Research-preview Claude Code "channels": push urgent hub alarms straight into the session. */
async function forwardAlarms(base: string, server: McpServer): Promise<void> {
  const notify = (content: string, meta: Record<string, string>) =>
    (server.server as unknown as { notification(n: { method: string; params: unknown }): Promise<void> })
      .notification({ method: 'notifications/claude/channel', params: { content, meta } })
      .catch(() => {});
  let delay = 2000;
  for (;;) {
    try {
      const res = await fetch(`${base}/api/stream`);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      delay = 2000;
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event !== 'alarm' || !data) continue;
          const ev = JSON.parse(data) as { source: string; severity: string; title: string; message?: string; code?: string; channelId?: string; push?: boolean };
          if (ev.source === 'claude' || !(ev.push || ev.severity !== 'info')) continue;
          await notify(`${ev.title}${ev.message ? ` — ${ev.message}` : ''}`, {
            severity: ev.severity,
            ...(ev.code ? { code: ev.code } : {}),
            ...(ev.channelId ? { channel: ev.channelId } : {}),
          });
        }
      }
    } catch {
      // hub not up yet / restarted — retry quietly
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 30_000);
  }
}
