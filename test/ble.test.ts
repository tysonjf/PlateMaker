// BleSource against a fake CoreBluetooth layer and a fake INT-12-BW base that enforces the handshake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Noble } from '@stoprocent/noble';
import { BleSource } from '../src/devices/ble.ts';
import { crc8Cdma2000, crc8DvbS2, splitFrames } from '../src/devices/protocols/inkbird-bw.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import type { DeviceStatus, SensorValue } from '../src/devices/types.ts';

class FakeChar extends EventEmitter {
  uuid: string;
  properties: string[];
  private dev: FakeInt12;
  constructor(dev: FakeInt12, uuid: string, properties: string[]) {
    super();
    this.dev = dev;
    this.uuid = uuid;
    this.properties = properties;
  }
  async writeAsync(data: Buffer) {
    this.dev.onWrite(this.uuid, data);
  }
  async readAsync() {
    return this.uuid === '2A19' ? Buffer.from([91, 100, 100]) : Buffer.alloc(0);
  }
  async subscribeAsync() {}
}

class FakeInt12 extends EventEmitter {
  id = 'c0ffee00c0ffee00c0ffee00c0ffee00';
  rssi = -58;
  state = 'disconnected';
  advertisement = { localName: 'Int12bw', serviceUuids: ['FF00'], manufacturerData: null };
  challenge = Buffer.from('5d734b60667d', 'hex');
  authed = false;
  connects = 0;
  // CoreBluetooth reports 16-bit UUIDs upper-case and short
  chars = [
    new FakeChar(this, 'FF01', ['read', 'notify']),
    new FakeChar(this, 'FF02', ['read', 'write', 'writeWithoutResponse', 'notify']),
    new FakeChar(this, 'FF03', ['read', 'notify']),
    new FakeChar(this, '2A19', ['read', 'notify']),
  ];
  private char(uuid: string) {
    return this.chars.find((c) => c.uuid === uuid)!;
  }
  private notify(uuid: string, data: Buffer) {
    setImmediate(() => this.state === 'connected' && this.char(uuid).emit('data', data, true));
  }
  onWrite(uuid: string, data: Buffer) {
    assert.equal(uuid, 'FF02');
    for (const f of splitFrames(data)) {
      if (f.type === 0xfb) this.notify('FF02', Buffer.concat([Buffer.from([0x07, 0xfb]), this.challenge]));
      if (f.type === 0xfc) {
        const t6 = [...f.payload.subarray(0, 6)];
        this.authed = crc8DvbS2([...t6, crc8DvbS2(t6), crc8Cdma2000(this.challenge)]) === f.payload[6];
        this.notify('FF02', Buffer.from([0x02, 0xfc, this.authed ? 0 : 1]));
      }
      if (f.type === 0xf1 && this.authed) {
        const t = Buffer.alloc(10);
        t.writeInt16LE(655, 0);
        t.writeInt16LE(1210, 2);
        t.writeInt16LE(32767, 5); // white probe not inserted
        this.notify('FF01', t);
        this.notify('FF03', Buffer.from([0x01, 0, 0x03, 0, 0, 0, 0])); // black in use, white docked
      }
    }
  }
  async connectAsync() {
    this.connects++;
    this.authed = false;
    this.state = 'connected';
  }
  cancelConnect() {}
  async disconnectAsync() {
    if (this.state === 'disconnected') return;
    this.state = 'disconnected';
    setImmediate(() => this.emit('disconnect', 0x13));
  }
  async discoverAllServicesAndCharacteristicsAsync() {
    return { services: [], characteristics: this.chars };
  }
}

class FakeNoble extends EventEmitter {
  state = 'poweredOn';
  async startScanningAsync() {}
  async stopScanningAsync() {}
  stop() {}
}

const until = async (cond: () => boolean, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('BleSource: discover → connect → handshake → stream → drop → reconnect', { timeout: 20_000 }, async () => {
  const noble = new FakeNoble();
  const dev = new FakeInt12();
  const statuses: DeviceStatus[] = [];
  const readings: SensorValue[][] = [];
  const src = new BleSource({ ...structuredClone(DEFAULT_CONFIG) }, async () => noble as unknown as Noble);
  await src.start({
    device: (s) => statuses.push(s),
    sensors: (_id, v) => readings.push(v),
    log: () => {},
  });
  noble.emit('discover', dev);
  await until(() => readings.length > 0, 5000, 'first readings');
  assert.ok(dev.authed, 'handshake accepted by fake base');
  const last = readings.at(-1)!;
  assert.deepEqual(
    last.map((s) => [s.index, s.tempC, s.status]),
    [
      [0, 65.5, 'ok'],
      [1, 121, 'ok'],
      [2, null, 'docked'],
    ],
  );
  assert.ok(statuses.some((s) => s.connected && s.model === 'INT-12-BW'));
  await until(() => statuses.some((s) => s.batteryPct === 91), 2000, 'battery');

  // Link drops (base out of range / rebooted): status goes disconnected, then we reconnect on the next advert.
  await dev.disconnectAsync();
  await until(() => statuses.at(-1)!.connected === false, 2000, 'disconnected status');
  const before = readings.length;
  await new Promise((r) => setTimeout(r, 2100)); // reconnect backoff
  noble.emit('discover', dev);
  await until(() => readings.length > before, 5000, 'readings after reconnect');
  assert.equal(dev.connects, 2);
  await src.stop();
});
