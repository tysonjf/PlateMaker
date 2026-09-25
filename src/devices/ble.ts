// Bluetooth LE source: finds supported thermometers, keeps a connection to each, and turns
// their notifications into SensorValues. Uses @stoprocent/noble (CoreBluetooth on macOS).

import type { Characteristic, Noble, Peripheral } from '@stoprocent/noble';
import type { Config } from '../config.ts';
import type { DeviceSource, DeviceStatus, SourceSink } from './types.ts';
import { findDriver } from './protocols/index.ts';
import { normUuid, withTimeout, type Advert, type Driver, type DriverSession, type GattLink } from './protocols/gatt.ts';

export async function loadNoble(): Promise<Noble> {
  try {
    const mod = await import('@stoprocent/noble');
    return (mod.default ?? mod) as Noble;
  } catch (err) {
    throw new Error(`Could not load the Bluetooth library (@stoprocent/noble): ${(err as Error).message}. Try \`pnpm install\` again.`);
  }
}

export async function waitForAdapter(noble: Noble, log: SourceSink['log'], timeoutMs = 20_000): Promise<void> {
  if (noble.state === 'poweredOn') return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      noble.removeListener('stateChange', onState);
      reject(new Error(`Bluetooth adapter not ready (state: ${noble.state}). Is Bluetooth turned on?`));
    }, timeoutMs);
    const onState = (state: string) => {
      if (state === 'poweredOn') {
        clearTimeout(timer);
        noble.removeListener('stateChange', onState);
        resolve();
      } else if (state === 'unauthorized') {
        clearTimeout(timer);
        noble.removeListener('stateChange', onState);
        reject(
          new Error(
            'macOS blocked Bluetooth for this terminal. Open System Settings → Privacy & Security → Bluetooth, ' +
              'allow your terminal app (Terminal, iTerm, Ghostty, VS Code…), then quit and reopen it and run this again.',
          ),
        );
      } else if (state === 'poweredOff') {
        log('warn', 'Bluetooth is turned off — turn it on in Control Center.');
      }
    };
    noble.on('stateChange', onState);
    onState(noble.state);
  });
}

export function advertOf(p: Peripheral): Advert {
  const a = p.advertisement ?? ({} as Peripheral['advertisement']);
  return {
    name: a.localName ?? '',
    serviceUuids: (a.serviceUuids ?? []).map(normUuid),
    manufacturerData: a.manufacturerData ?? null,
  };
}

export function makeLink(chars: Characteristic[]): GattLink {
  const byUuid = new Map<string, Characteristic>();
  for (const c of chars) if (!byUuid.has(normUuid(c.uuid))) byUuid.set(normUuid(c.uuid), c);
  const get = (uuid: string) => {
    const c = byUuid.get(normUuid(uuid));
    if (!c) throw new Error(`Characteristic ${uuid} not found (have: ${[...byUuid.keys()].join(', ')})`);
    return c;
  };
  return {
    has: (uuid) => byUuid.has(normUuid(uuid)),
    async write(uuid, data) {
      const c = get(uuid);
      const canNoRsp = c.properties.includes('writeWithoutResponse');
      if (!c.properties.includes('write') && canNoRsp) {
        await withTimeout(c.writeAsync(data, true), 5000, `write ${uuid}`);
        return;
      }
      try {
        await withTimeout(c.writeAsync(data, false), 5000, `write ${uuid}`);
      } catch (err) {
        // Implementations disagree on the write type for the Inkbird control characteristic; fall back.
        if (!canNoRsp) throw err;
        await withTimeout(c.writeAsync(data, true), 5000, `write ${uuid}`);
      }
    },
    async read(uuid) {
      return withTimeout(get(uuid).readAsync(), 5000, `read ${uuid}`);
    },
    async subscribe(uuid, onData) {
      const c = get(uuid);
      c.on('data', (data: Buffer) => onData(data));
      await withTimeout(c.subscribeAsync(), 5000, `subscribe ${uuid}`);
    },
  };
}

interface Tracked {
  peripheral: Peripheral;
  status: DeviceStatus;
  phase: 'idle' | 'connecting' | 'connected';
  session: DriverSession | null;
  failures: number;
  retryAt: number;
}

export class BleSource implements DeviceSource {
  readonly kind = 'ble' as const;
  private cfg: Config;
  private noble: Noble | null = null;
  private sink: SourceSink | null = null;
  private tracked = new Map<string, Tracked>();
  private hintTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  async start(sink: SourceSink): Promise<void> {
    this.sink = sink;
    const noble = (this.noble = await loadNoble());
    sink.log('info', 'Waiting for Bluetooth… (macOS may ask to allow Bluetooth for your terminal the first time)');
    await waitForAdapter(noble, sink.log);
    noble.on('discover', (p: Peripheral) => this.onDiscover(p));
    noble.on('stateChange', (state: string) => {
      if (state !== 'poweredOn') sink.log('warn', `Bluetooth adapter is now ${state}`);
      else if (!this.stopped) void this.scan();
    });
    await this.scan();
    sink.log('info', 'Scanning for Inkbird thermometers…');
    this.hintTimer = setTimeout(() => {
      if (![...this.tracked.values()].some((t) => t.phase === 'connected')) {
        sink.log(
          'warn',
          'No thermometer connected yet. Check: (1) the INKBIRD phone app is fully closed — the base only allows one Bluetooth connection; ' +
            '(2) the base is awake — take a probe out of the dock or press its button; (3) the Mac is within ~10 m. `pnpm scan` lists what the Mac can see.',
        );
      }
    }, 45_000);
  }

  private async scan(): Promise<void> {
    try {
      await this.noble!.startScanningAsync([], true);
    } catch (err) {
      this.sink?.log('error', `Could not start scanning: ${(err as Error).message}`);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.hintTimer) clearTimeout(this.hintTimer);
    for (const t of this.tracked.values()) {
      t.session?.stop();
      if (t.phase !== 'idle') await t.peripheral.disconnectAsync().catch(() => {});
    }
    await this.noble?.stopScanningAsync().catch(() => {});
    this.noble?.stop?.();
  }

  private allowed(id: string): boolean {
    if (this.cfg.devices[id]?.ignore) return false;
    return !this.cfg.onlyDevices.length || this.cfg.onlyDevices.includes(id);
  }

  private onDiscover(p: Peripheral): void {
    if (this.stopped) return;
    const adv = advertOf(p);
    const match = findDriver(adv);
    if (!match || !this.allowed(p.id)) return;
    const now = Date.now();
    let t = this.tracked.get(p.id);
    if (!t) {
      t = {
        peripheral: p,
        phase: 'idle',
        session: null,
        failures: 0,
        retryAt: 0,
        status: {
          id: p.id,
          name: adv.name || match.model,
          model: match.model,
          connected: false,
          rssi: p.rssi ?? null,
          batteryPct: null,
          lastSeen: now,
          lastData: null,
          state: 'found',
        },
      };
      this.tracked.set(p.id, t);
      this.sink!.log('info', `Found ${match.model} "${adv.name}" (${p.id}, ${p.rssi} dBm)`);
    }
    t.peripheral = p;
    t.status.rssi = p.rssi ?? t.status.rssi;
    t.status.lastSeen = now;
    if (t.phase === 'idle' && now >= t.retryAt) void this.connect(t, match.driver, match.model);
  }

  private update(t: Tracked, patch: Partial<DeviceStatus>): void {
    Object.assign(t.status, patch);
    this.sink!.device({ ...t.status });
  }

  private async connect(t: Tracked, driver: Driver, model: string): Promise<void> {
    const p = t.peripheral;
    const sink = this.sink!;
    t.phase = 'connecting';
    this.update(t, { state: 'connecting' });
    const pausedScan = process.platform !== 'darwin';
    if (pausedScan) await this.noble!.stopScanningAsync().catch(() => {});
    try {
      await withTimeout(p.connectAsync(), 20_000, 'connect').catch((err) => {
        p.cancelConnect();
        throw err;
      });
      p.once('disconnect', (reason: unknown) => this.onDisconnect(t, reason));
      const { characteristics } = await withTimeout(p.discoverAllServicesAndCharacteristicsAsync(), 20_000, 'service discovery');
      const link = makeLink(characteristics);
      t.phase = 'connected';
      this.update(t, { connected: true, state: 'handshake' });
      t.session = await driver.run(
        link,
        {
          log: (level, msg) => sink.log(level, msg),
          sensors: (values) => {
            t.status.lastData = Date.now();
            sink.sensors(p.id, values, Date.now());
          },
          status: (patch) => this.update(t, patch),
          reconnect: (reason) => {
            sink.log('warn', `${t.status.name}: reconnecting (${reason})`);
            p.disconnectAsync().catch(() => {});
          },
          now: () => Date.now(),
        },
        model,
      );
      t.failures = 0;
    } catch (err) {
      t.failures++;
      const delay = Math.min(30_000, 2_000 * 2 ** Math.min(t.failures, 4));
      sink.log('warn', `${t.status.name}: connection failed (${(err as Error).message}); retrying in ${Math.round(delay / 1000)}s`);
      if (t.failures === 3) {
        sink.log('warn', 'Repeated failures usually mean the INKBIRD phone app (or another device) is holding the connection. Close it completely.');
      }
      t.session?.stop();
      t.session = null;
      t.phase = 'idle';
      t.retryAt = Date.now() + delay;
      this.update(t, { connected: false, state: `retrying: ${(err as Error).message}` });
      await p.disconnectAsync().catch(() => {});
    } finally {
      if (pausedScan && !this.stopped) await this.scan();
    }
  }

  private onDisconnect(t: Tracked, reason: unknown): void {
    t.session?.stop();
    t.session = null;
    if (t.phase === 'idle') return;
    t.phase = 'idle';
    t.retryAt = Date.now() + 2_000;
    this.update(t, { connected: false, state: `disconnected${reason != null ? ` (${String(reason)})` : ''} — waiting for it to advertise again` });
  }
}
