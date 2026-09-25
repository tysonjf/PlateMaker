import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { Hub, type Clock } from '../src/hub/hub.ts';
import type { DeviceSource } from '../src/devices/types.ts';

const MIN = 60_000;

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'smoke-signal-hub-'));
  let now = Date.UTC(2026, 8, 26, 12, 0, 0);
  const clock: Clock = { now: () => now, speed: 1 };
  const source: DeviceSource = { kind: 'ble', start: async () => {}, stop: async () => {} };
  const cfg = { ...structuredClone(DEFAULT_CONFIG), desktopNotifications: false, sampleSeconds: 3600 };
  const hub = new Hub({ cfg, source, clock, dataDir: home });
  return {
    home,
    hub,
    advance: (ms: number) => (now += ms),
    cleanup: async () => {
      await hub.stop();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test('Claude heartbeat alarm only once Claude has been checking in regularly', async () => {
  const { hub, advance, cleanup } = setup();
  try {
    await hub.start();
    hub.startCook({ name: 'Heartbeat test' });
    // A single question from the desktop app, then silence: no alarm.
    hub.markClaudeCheck();
    advance(40 * MIN);
    hub.tick();
    assert.ok(!hub.store.events.some((e) => e.code === 'claude_silent'), 'one-off check must not arm the heartbeat');

    // Regular 5-minute check-ins, then silence: alarm, then cleared when checks resume.
    for (let i = 0; i < 4; i++) {
      advance(5 * MIN);
      hub.markClaudeCheck();
      hub.tick();
    }
    advance(25 * MIN);
    hub.tick();
    assert.ok(hub.store.events.some((e) => e.type === 'alarm' && e.code === 'claude_silent'));
    hub.markClaudeCheck();
    hub.tick();
    assert.ok(hub.store.events.some((e) => e.type === 'alarm-cleared' && e.code === 'claude_silent'));
  } finally {
    await cleanup();
  }
});

test('hub resumes the cook log after a restart', async () => {
  const { home, hub, advance, cleanup } = setup();
  try {
    await hub.start();
    hub.sensors('dev', [{ index: 0, kind: 'meat', tempC: 50, name: 'Black probe' }], Date.UTC(2026, 8, 26, 12, 0, 0));
    hub.tick();
    hub.startCook({ name: 'Resume me', channels: { A1: { label: 'Flat', targetC: 95 } } });
    hub.addNote('wrapped');
    advance(MIN);
    await hub.stop();

    const again = new Hub({
      cfg: { ...structuredClone(DEFAULT_CONFIG), desktopNotifications: false },
      source: { kind: 'ble', start: async () => {}, stop: async () => {} },
      clock: { now: () => Date.UTC(2026, 8, 26, 12, 5, 0), speed: 1 },
      dataDir: home,
    });
    await again.start();
    assert.equal(again.store.meta.name, 'Resume me');
    assert.equal(again.store.meta.settings.A1.label, 'Flat');
    assert.equal(again.store.samples.length, 1);
    assert.ok(again.store.events.some((e) => e.type === 'note' && e.title === 'wrapped'));
    await again.stop();
  } finally {
    await cleanup();
  }
});
