import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hub, CookUpdate } from './hub.ts';
import { history } from './analytics.ts';
import { buildCheckIn } from './report.ts';
import { fromUnit, type Unit } from '../units.ts';
import type { Severity } from './store.ts';

const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, '..', '..', 'web');

const STATIC: Record<string, { file: () => string; type: string }> = {
  '/': { file: () => join(webDir, 'index.html'), type: 'text/html; charset=utf-8' },
  '/app.js': { file: () => join(webDir, 'app.js'), type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: () => join(webDir, 'style.css'), type: 'text/css; charset=utf-8' },
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json',
    'cache-control': 'no-store',
  });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 256 * 1024) throw new HttpError(413, 'Body too large');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

function isLoopback(req: IncomingMessage): boolean {
  const a = req.socket.remoteAddress ?? '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

/** Temperatures in request bodies are in `unit` (default: hub unit); convert to °C. */
function tempIn(v: unknown, unit: Unit): number | null | undefined {
  if (v === null) return null;
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new HttpError(400, `Not a number: ${v}`);
  return fromUnit(n, unit);
}

export function parseCookUpdate(body: Record<string, unknown>, hubUnit: Unit): CookUpdate & { newSession?: boolean } {
  const unit: Unit = body.unit === 'C' || body.unit === 'F' ? body.unit : hubUnit;
  const u: CookUpdate & { newSession?: boolean } = {};
  for (const k of ['name', 'meat', 'method', 'goal'] as const) if (typeof body[k] === 'string') u[k] = body[k] as string;
  if (body.weight != null) {
    const w = Number(body.weight);
    if (!Number.isFinite(w)) throw new HttpError(400, 'weight must be a number');
    u.weightKg = body.weightUnit === 'kg' || (body.weightUnit == null && unit === 'C') ? w : w * 0.45359237;
  }
  if (body.serveAt === null) u.serveAt = null;
  else if (typeof body.serveAt === 'string' || typeof body.serveAt === 'number') {
    const t = typeof body.serveAt === 'number' ? body.serveAt : Date.parse(body.serveAt);
    if (!Number.isFinite(t)) throw new HttpError(400, `Unparseable serveAt: ${body.serveAt}`);
    u.serveAt = t;
  }
  if (body.newSession === true) u.newSession = true;
  if (body.channels && typeof body.channels === 'object') {
    u.channels = {};
    for (const [id, raw] of Object.entries(body.channels as Record<string, Record<string, unknown>>)) {
      const c: NonNullable<CookUpdate['channels']>[string] = {};
      if (raw.label !== undefined) c.label = raw.label === null ? null : String(raw.label);
      if (raw.role !== undefined) {
        if (!['meat', 'pit', 'off'].includes(String(raw.role))) throw new HttpError(400, `role must be meat, pit or off`);
        c.role = raw.role as 'meat' | 'pit' | 'off';
      }
      for (const [src, dst] of [['target', 'targetC'], ['low', 'lowC'], ['high', 'highC']] as const) {
        const v = tempIn(raw[src], unit);
        if (v !== undefined) c[dst] = v;
      }
      u.channels[id.toUpperCase()] = c;
    }
  }
  return u;
}

export function startServer(hub: Hub, opts: { host: string; port: number }): Promise<{ close(): void; url: string }> {
  const sse = new Set<ServerResponse>();

  const broadcast = (event: string, data: unknown) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sse) res.write(msg);
  };
  hub.on('sample', (row) => broadcast('sample', row));
  hub.on('event', (ev) => broadcast('event', ev));
  hub.on('alarm', (ev, push) => broadcast('alarm', { ...ev, push }));
  hub.on('device', (d) => broadcast('device', d));
  hub.on('cook', (m) => broadcast('cook', m));
  const heartbeat = setInterval(() => {
    for (const res of sse) res.write(': ping\n\n');
  }, 20_000);

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (method !== 'GET' && !isLoopback(req)) throw new HttpError(403, 'Changes are only allowed from this Mac');
    // Browsers on other origins must not be able to drive the hub (DNS rebinding / CSRF).
    const origin = req.headers.origin;
    if (method !== 'GET' && origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      throw new HttpError(403, 'Cross-origin request refused');
    }

    const st = STATIC[path];
    if (method === 'GET' && st) {
      const body = await readFile(st.file());
      res.writeHead(200, { 'content-type': st.type, 'cache-control': 'no-cache' });
      res.end(body);
      return;
    }

    if (method === 'GET' && path === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(`event: hello\ndata: ${JSON.stringify(hub.snapshot())}\n\n`);
      sse.add(res);
      req.on('close', () => sse.delete(res));
      return;
    }

    if (method === 'GET' && path === '/api/status') return send(res, 200, hub.snapshot());

    if (method === 'GET' && path === '/api/report') {
      const since = url.searchParams.get('since');
      if (url.searchParams.get('client') === 'claude') hub.markClaudeCheck();
      const snapshot = hub.snapshot();
      const d = url.searchParams.get('detail');
      const detail = d === 'brief' || d === 'auto' ? d : 'full';
      const text = buildCheckIn(snapshot, { since: since ? Number(since) : null, detail });
      if (url.searchParams.get('format') === 'json') return send(res, 200, { now: snapshot.now, text, snapshot });
      return send(res, 200, text);
    }

    if (method === 'GET' && path === '/api/history') {
      const snap = hub.snapshot();
      const now = snap.now;
      const minutes = Math.min(Number(url.searchParams.get('minutes') ?? 240), 48 * 60);
      const from = url.searchParams.get('from') ? Number(url.searchParams.get('from')) : now - minutes * 60_000;
      const span = now - from;
      const bucketParam = url.searchParams.get('bucketSeconds');
      const bucketMs = bucketParam ? Math.max(5, Number(bucketParam)) * 1000 : Math.max(hub.cfg.sampleSeconds * 1000, Math.ceil(span / 600 / 5000) * 5000);
      const ids = (url.searchParams.get('channels')?.split(',').map((s) => s.trim().toUpperCase()) ?? Object.keys(snap.cook.channels)).filter(
        (id) => snap.cook.channels[id],
      );
      const labels = Object.fromEntries(snap.analyses.filter((a) => ids.includes(a.id)).map((a) => [a.id, a.label]));
      return send(res, 200, { now, unit: hub.cfg.unit, bucketMs, labels, ...history(hub.store.samples, ids, from, now, bucketMs) });
    }

    if (method === 'GET' && path === '/api/events') {
      const since = Number(url.searchParams.get('since') ?? 0);
      return send(res, 200, hub.store.events.filter((e) => e.at > since));
    }

    if (method === 'POST' && path === '/api/cook/start') {
      const body = await readJson(req);
      const u = parseCookUpdate(body, hub.cfg.unit);
      return send(res, 200, hub.startCook({ ...u, startedAt: body.startedAt ? Date.parse(String(body.startedAt)) : undefined }));
    }
    if (method === 'POST' && path === '/api/cook') {
      return send(res, 200, hub.updateCook(parseCookUpdate(await readJson(req), hub.cfg.unit)));
    }
    if (method === 'POST' && path === '/api/cook/end') {
      const body = await readJson(req);
      return send(res, 200, hub.endCook(typeof body.summary === 'string' ? body.summary : undefined));
    }
    if (method === 'POST' && path === '/api/notes') {
      const body = await readJson(req);
      const text = String(body.text ?? '').trim();
      if (!text) throw new HttpError(400, 'text is required');
      const source = body.source === 'claude' ? 'claude' : 'user';
      return send(res, 200, hub.addNote(text.slice(0, 500), source));
    }
    if (method === 'POST' && path === '/api/alert') {
      const body = await readJson(req);
      const severity = (['info', 'warning', 'critical'].includes(String(body.severity)) ? body.severity : 'warning') as Severity;
      const title = String(body.title ?? '').trim();
      if (!title) throw new HttpError(400, 'title is required');
      return send(res, 200, hub.sendAlert({ title: title.slice(0, 120), message: String(body.message ?? '').slice(0, 1000), severity }));
    }
    if (method === 'POST' && path === '/api/unit') {
      const body = await readJson(req);
      if (body.unit !== 'C' && body.unit !== 'F') throw new HttpError(400, 'unit must be C or F');
      hub.cfg.unit = body.unit;
      hub.emit('cook', hub.store.meta);
      return send(res, 200, { unit: hub.cfg.unit });
    }
    throw new HttpError(404, `No route for ${method} ${path}`);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: Error) => {
      const status = err instanceof HttpError ? err.status : 400;
      if (!res.headersSent) send(res, status, { error: err.message });
      else res.end();
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      resolve({
        url: `http://${opts.host === '0.0.0.0' ? 'localhost' : opts.host}:${port}`,
        close: () => {
          clearInterval(heartbeat);
          for (const r of sse) r.end();
          server.close();
        },
      });
    });
  });
}

