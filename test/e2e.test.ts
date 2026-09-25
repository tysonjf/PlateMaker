// End-to-end: simulator → hub → HTTP API → real MCP server process → MCP client (as Claude would).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { Hub, acceleratedClock } from '../src/hub/hub.ts';
import { startServer } from '../src/hub/server.ts';
import { SimSource } from '../src/devices/sim.ts';

test('simulated cook driven through the MCP server', { timeout: 60_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'smoke-signal-e2e-'));
  const cfg = { ...structuredClone(DEFAULT_CONFIG), desktopNotifications: false, devices: {} };
  const clock = acceleratedClock(60);
  const hub = new Hub({ cfg, source: new SimSource(clock, { startHours: 5 }), clock, dataDir: home, freshCook: true });
  await hub.start();
  const server = await startServer(hub, { host: '127.0.0.1', port: 0 });
  const client = new Client({ name: 'e2e', version: '1.0.0' });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(import.meta.dirname, '..', 'bin', 'smoke-signal.mjs'), 'mcp'],
        env: { ...(process.env as Record<string, string>), SMOKE_SIGNAL_URL: server.url, SMOKE_SIGNAL_HOME: home },
        stderr: 'ignore',
      }),
    );
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['end_cook', 'get_cook_report', 'get_temperature_history', 'log_event', 'send_alert', 'start_cook', 'update_cook']);

    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await client.callTool({ name, arguments: args });
      const text = (r.content as { text: string }[]).map((c) => c.text).join('\n');
      assert.ok(!r.isError, `${name} failed: ${text}`);
      return text;
    };

    const started = await call('start_cook', {
      name: 'E2E brisket',
      meat: 'packer brisket',
      weight: 14,
      weight_unit: 'lb',
      probes: [
        { channel: 'A1', label: 'Flat', target: 203 },
        { channel: 'A3', label: 'Point', target: 203 },
      ],
      pit_low: 225,
      pit_high: 275,
      unit: 'F',
    });
    assert.match(started, /Cook: "E2E brisket"/);
    assert.match(started, /PIT {2}Pit \[A2\].*range 225°F–275°F/);
    assert.match(started, /MEAT Flat \[A1\].*target 203°F/);
    assert.match(started, /MEAT Point \[A3\]/);

    const settings = hub.store.meta.settings;
    assert.equal(Math.round(settings.A1.targetC!), 95);
    assert.equal(Math.round(settings.A2.lowC!), 107);

    // Second check with nothing new is either the brief or (if the sim is mid-drama) the full report.
    const again = await call('get_cook_report');
    assert.ok(/^Check-in /.test(again) || /^Smoke Signal check-in/.test(again), again);

    assert.match(await call('get_cook_report', { detail: 'full' }), /Devices: .*INT-12-BW connected/);
    assert.match(await call('log_event', { text: 'Added two splits of oak' }), /Logged/);
    assert.match(await call('send_alert', { title: 'Test', message: 'hello', severity: 'info' }), /Alert sent/);
    assert.match(await call('get_temperature_history', { minutes: 60, bucket_minutes: 10 }), /time \| .*Flat \[A1\]/);
    assert.match(await call('end_cook', { summary: 'e2e' }), /ENDED/);

    const kinds = hub.store.events.map((e) => e.type);
    assert.ok(kinds.includes('note') && kinds.includes('claude'), kinds.join(','));
  } finally {
    await client.close().catch(() => {});
    server.close();
    await hub.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test('MCP server explains how to start the hub when it is not running', { timeout: 30_000 }, async () => {
  const client = new Client({ name: 'e2e', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(import.meta.dirname, '..', 'bin', 'smoke-signal.mjs'), 'mcp'],
      env: { ...(process.env as Record<string, string>), SMOKE_SIGNAL_URL: 'http://127.0.0.1:9' },
      stderr: 'ignore',
    }),
  );
  try {
    const r = await client.callTool({ name: 'get_cook_report', arguments: {} });
    assert.equal(r.isError, true);
    assert.match((r.content as { text: string }[])[0].text, /pnpm start/);
  } finally {
    await client.close();
  }
});
