import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  authFrame,
  chunkFrames,
  clockSyncFrame,
  crc8Cdma2000,
  crc8DvbS2,
  INIT_FRAMES,
  matchName,
  parseBattery,
  parseProbeStates,
  parseTemps,
  POLL,
  runInkbirdBw,
  splitFrames,
  verifyBody,
} from '../src/devices/protocols/inkbird-bw.ts';
import type { DriverContext, GattLink } from '../src/devices/protocols/gatt.ts';
import type { SensorValue } from '../src/devices/types.ts';

// Captured (challenge → 08 FC body) pairs from a real INT-12-BW, published with the protocol
// write-up at github.com/paul43210/inkbird-bw-ble.
const VECTORS: [string, string][] = [
  ['2a19e11e78aa', 'e2019f5a186a78'],
  ['5d734b60667d', '2100e45a186a9c'],
  ['47377c8de21e', 'a401135b186aa5'],
  ['596c67b2e5d3', '80003a5b186a8f'],
  ['cb6ec0dcf745', '1e02665b186a54'],
  ['b5af2104872d', '41038f5b186a78'],
  ['ffa2421a66a9', '2b00a75b186a24'],
  ['8950e5402fc7', '2f02cf5b186a85'],
  ['6ba0ca5c6ee9', '2103ec5b186a10'],
  ['2daa38762211', 'd201075c186a2b'],
  ['a00e0f1e07ce', '92009259186afd'],
  ['b806c756e057', '0e03cd57186aa1'],
  ['4a6db7788717', '7201f157186a87'],
  ['ec7039b602f2', '64033158186a4c'],
  ['3e3548d38de7', '52015058186ae8'],
  ['b0b70b26dcec', '6d01265d186a2a'],
  ['d228101ad821', 'aa02325f186aa0'],
];

test('auth response matches all 17 captured vectors', () => {
  for (const [ch, rsp] of VECTORS) {
    const challenge = Buffer.from(ch, 'hex');
    const expected = Buffer.from(rsp, 'hex');
    const ms = expected.readUInt16LE(0);
    const epoch = expected.readUInt32LE(2);
    assert.equal(verifyBody(challenge, epoch, ms).toString('hex'), rsp, `challenge ${ch}`);
    const frame = authFrame(challenge, epoch * 1000 + ms);
    assert.equal(frame.toString('hex'), `08fc${rsp}`);
  }
});

test('crc8 variants match catalogue check values', () => {
  const check = Buffer.from('123456789', 'ascii');
  assert.equal(crc8DvbS2(check), 0xbc); // CRC-8/DVB-S2 check value
  assert.equal(crc8Cdma2000(check), 0xda); // CRC-8/CDMA2000 check value
});

test('clock sync frame layout', () => {
  const f = clockSyncFrame(1779980959482);
  assert.equal(f.toString('hex'), '07199f5a186ae201');
});

test('frames split and chunk on boundaries', () => {
  const frames = splitFrames(Buffer.from('07fb2a19e11e78aa02fc00', 'hex'));
  assert.deepEqual(
    frames.map((f) => [f.type, f.payload.toString('hex')]),
    [
      [0xfb, '2a19e11e78aa'],
      [0xfc, '00'],
    ],
  );
  const chunks = chunkFrames(INIT_FRAMES, 18);
  assert.ok(chunks.every((c) => c.length <= 18));
  assert.equal(Buffer.concat(chunks).length, INIT_FRAMES.flat().length);
  // every chunk must itself parse into whole frames
  for (const c of chunks) assert.equal(splitFrames(c).reduce((n, f) => n + 2 + f.payload.length, 0), c.length);
});

test('parses INT-12-BW temperature frames and sentinels', () => {
  const b = Buffer.alloc(10);
  b.writeInt16LE(652, 0); // black tip 65.2 °C
  b.writeInt16LE(1213, 2); // black ambient 121.3 °C
  b.writeInt16LE(32767, 5); // white: no probe
  b.writeInt16LE(245, 8); // base 24.5 °C
  const t = parseTemps(b)!;
  assert.equal(t.probes[0].tip, 65.2);
  assert.equal(t.probes[0].ambient, 121.3);
  assert.equal(t.probes[1].tip, null);
  assert.equal(t.base, 24.5);
  const neg = Buffer.alloc(10);
  neg.writeInt16LE(-55, 0);
  assert.equal(parseTemps(neg)!.probes[0].tip, -5.5);
});

test('parses dock state, battery and model names', () => {
  const st = parseProbeStates(Buffer.from([0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]), 2);
  assert.deepEqual(st, [
    { connected: true, docked: true },
    { connected: true, docked: false },
  ]);
  assert.deepEqual(parseBattery(Buffer.from([80, 0x7f, 120])), { base: 80, probes: [null, 100] });
  assert.equal(matchName('Int12bw'), 'INT-12-BW');
  assert.equal(matchName('INT-12-BW'), 'INT-12-BW');
  assert.equal(matchName('INT-14-BW'), 'INT-14-BW');
  assert.equal(matchName('INT-11P-B'), null); // different protocol
  assert.equal(matchName('iBBQ'), null);
});

/** A fake INT-12-BW base that enforces the auth handshake like the real one. */
class FakeBase implements GattLink {
  subs = new Map<string, (d: Buffer) => void>();
  challenge = Buffer.from('2a19e11e78aa', 'hex');
  authed = false;
  writes: string[] = [];
  has(uuid: string) {
    return ['ff01', 'ff02', 'ff03', '2a19'].includes(uuid);
  }
  async read(uuid: string) {
    if (uuid === '2a19') return Buffer.from([88, 100, 97]);
    return Buffer.alloc(0);
  }
  async subscribe(uuid: string, cb: (d: Buffer) => void) {
    this.subs.set(uuid, cb);
  }
  async write(uuid: string, data: Buffer) {
    assert.equal(uuid, 'ff02');
    this.writes.push(data.toString('hex'));
    const notify = (u: string, d: Buffer) => setImmediate(() => this.subs.get(u)?.(d));
    for (const f of splitFrames(data)) {
      if (f.type === 0xfb) notify('ff02', Buffer.concat([Buffer.from([0x07, 0xfb]), this.challenge]));
      if (f.type === 0xfc) {
        const time6 = [...f.payload.subarray(0, 6)];
        const want = crc8DvbS2([...time6, crc8DvbS2(time6), crc8Cdma2000(this.challenge)]);
        this.authed = want === f.payload[6];
        notify('ff02', Buffer.from([0x02, 0xfc, this.authed ? 0x00 : 0x01]));
      }
      if (f.type === 0xf1 && this.authed) {
        const t = Buffer.alloc(10);
        t.writeInt16LE(701, 0);
        t.writeInt16LE(1180, 2);
        t.writeInt16LE(655, 5);
        notify('ff01', t);
        notify('ff03', Buffer.from([0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]));
      }
    }
  }
}

test('session authenticates against a fake base and streams sensors', async () => {
  const base = new FakeBase();
  const got: SensorValue[][] = [];
  const statuses: unknown[] = [];
  const ctx: DriverContext = {
    log: () => {},
    sensors: (v) => got.push(v),
    status: (p) => statuses.push(p),
    reconnect: () => assert.fail('should not reconnect'),
    now: () => Date.now(),
  };
  const session = await runInkbirdBw(base, ctx, 'INT-12-BW');
  await new Promise((r) => setTimeout(r, 50));
  session.stop();
  assert.ok(base.authed, 'auth response accepted by fake base');
  assert.ok(base.writes.includes(POLL.toString('hex')), 'poll sent');
  const last = got.at(-1)!;
  assert.deepEqual(
    last.map((s) => [s.index, s.kind, s.tempC, s.name]),
    [
      [0, 'meat', 70.1, 'Black probe'],
      [1, 'ambient', 118, 'Black probe (ambient)'],
      [2, 'meat', 65.5, 'White probe'],
    ],
  );
  assert.ok(statuses.some((s) => (s as { batteries?: Record<string, number> }).batteries?.base === 88));
});
