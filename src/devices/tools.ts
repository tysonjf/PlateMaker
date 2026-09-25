// `pnpm scan` and `pnpm explore`: see what the Mac can hear, and dump a device's GATT table and
// raw notifications (with the handshake) for troubleshooting or teaching Smoke Signal a new model.

import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Characteristic, Peripheral } from '@stoprocent/noble';
import { dataDir } from '../config.ts';
import { advertOf, loadNoble, makeLink, waitForAdapter } from './ble.ts';
import { findDriver } from './protocols/index.ts';
import { hex, normUuid, sleep, withTimeout } from './protocols/gatt.ts';

const log = (level: string, msg: string) => console.log(`${level === 'info' ? '' : `[${level}] `}${msg}`);

export async function scan(seconds: number, all: boolean): Promise<void> {
  const noble = await loadNoble();
  await waitForAdapter(noble, log);
  const seen = new Map<string, { p: Peripheral; name: string; rssi: number; services: string[]; mfr: string; model: string | null }>();
  noble.on('discover', (p: Peripheral) => {
    const adv = advertOf(p);
    const prev = seen.get(p.id);
    const match = findDriver(adv);
    seen.set(p.id, {
      p,
      name: adv.name || prev?.name || '',
      rssi: p.rssi,
      services: adv.serviceUuids.length ? adv.serviceUuids : prev?.services ?? [],
      mfr: adv.manufacturerData ? hex(adv.manufacturerData) : prev?.mfr ?? '',
      model: match?.model ?? prev?.model ?? null,
    });
  });
  console.log(`Scanning for ${seconds}s… (take a probe out of the Inkbird base to wake it up)`);
  await noble.startScanningAsync([], true);
  await sleep(seconds * 1000);
  await noble.stopScanningAsync();
  const rows = [...seen.values()]
    .filter((r) => all || r.model || r.name)
    .sort((a, b) => Number(!!b.model) - Number(!!a.model) || b.rssi - a.rssi);
  if (!rows.length) console.log('Nothing found. Is Bluetooth on, and has your terminal been allowed Bluetooth access?');
  for (const r of rows) {
    console.log(
      `${r.model ? `✔ ${r.model.padEnd(10)}` : '  ' + ''.padEnd(10)} ${String(r.rssi).padStart(4)} dBm  ${r.name.padEnd(22)} id=${r.p.id}` +
        (r.services.length ? `  services=${r.services.join(',')}` : '') +
        (r.mfr && (all || r.model) ? `  mfr=${r.mfr}` : ''),
    );
  }
  const found = rows.filter((r) => r.model);
  console.log(
    found.length
      ? `\n${found.length} supported thermometer(s) found. \`pnpm start\` connects to them automatically.`
      : `\nNo supported thermometer seen. Close the INKBIRD phone app (only one Bluetooth connection is allowed), wake the base, and try again.${all ? '' : ' Use `pnpm scan --all` to list every device.'}`,
  );
  noble.stop?.();
  process.exit(0);
}

export async function explore(target: string | undefined, seconds: number, auth: boolean): Promise<void> {
  mkdirSync(dataDir(), { recursive: true });
  const file = join(dataDir(), `explore-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  const out = createWriteStream(file);
  const t0 = Date.now();
  const say = (msg: string) => {
    const line = `[${((Date.now() - t0) / 1000).toFixed(2).padStart(7)}s] ${msg}`;
    console.log(line);
    out.write(line + '\n');
  };

  const noble = await loadNoble();
  await waitForAdapter(noble, log);
  say(`Looking for ${target ? `"${target}"` : 'a supported thermometer'}… (wake the base by taking out a probe)`);
  const wanted = target?.toLowerCase();
  const p = await new Promise<Peripheral>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Device not found within 60s')), 60_000);
    noble.on('discover', (dev: Peripheral) => {
      const adv = advertOf(dev);
      const ok = wanted ? dev.id.toLowerCase() === wanted || adv.name.toLowerCase().includes(wanted) : !!findDriver(adv);
      if (!ok) return;
      clearTimeout(timer);
      resolve(dev);
    });
    noble.startScanningAsync([], true).catch(reject);
  });
  await noble.stopScanningAsync();
  const adv = advertOf(p);
  const match = findDriver(adv);
  say(`Found "${adv.name}" id=${p.id} rssi=${p.rssi} services=[${adv.serviceUuids.join(', ')}] mfr=${adv.manufacturerData ? hex(adv.manufacturerData) : '-'}`);
  say(match ? `Recognised as ${match.model} (driver: ${match.driver.id})` : 'Not a recognised model — dumping raw data only.');

  await withTimeout(p.connectAsync(), 20_000, 'connect');
  say('Connected. Discovering services…');
  p.once('disconnect', (reason: unknown) => say(`Disconnected (${String(reason)})`));
  const { services, characteristics } = await withTimeout(p.discoverAllServicesAndCharacteristicsAsync(), 20_000, 'discovery');
  for (const s of services) {
    say(`Service ${normUuid(s.uuid)}`);
    for (const c of s.characteristics ?? []) say(`  └ ${normUuid(c.uuid).padEnd(6)} [${c.properties.join(', ')}]`);
  }

  for (const c of characteristics as Characteristic[]) {
    if (!c.properties.includes('read')) continue;
    try {
      const v = await withTimeout(c.readAsync(), 4000, 'read');
      say(`READ ${normUuid(c.uuid)} (${v.length}B): ${hex(v)}  "${v.toString('latin1').replace(/[^\x20-\x7e]/g, '.')}"`);
    } catch (err) {
      say(`READ ${normUuid(c.uuid)} failed: ${(err as Error).message}`);
    }
  }

  const describe = (d: Buffer) => {
    const ints: string[] = [];
    for (let i = 0; i + 1 < d.length; i++) {
      const v = d.readInt16LE(i) / 10;
      if (v > -20 && v < 350) ints.push(`@${i}=${v}°C`);
    }
    return ints.length ? `  plausible int16/10: ${ints.join(' ')}` : '';
  };
  for (const c of characteristics as Characteristic[]) {
    if (!c.properties.includes('notify') && !c.properties.includes('indicate')) continue;
    c.on('data', (d: Buffer, isNotification: boolean) => {
      if (isNotification !== false) say(`NOTIFY ${normUuid(c.uuid)} (${d.length}B): ${hex(d)}${describe(d)}`);
    });
    await withTimeout(c.subscribeAsync(), 5000, 'subscribe').catch((err) => say(`subscribe ${normUuid(c.uuid)} failed: ${(err as Error).message}`));
  }

  if (match && auth) {
    say(`Running the ${match.driver.id} handshake…`);
    const link = makeLink(characteristics);
    const loggingLink = {
      ...link,
      write: async (uuid: string, data: Buffer) => {
        say(`WRITE ${normUuid(uuid)} (${data.length}B): ${hex(data)}`);
        return link.write(uuid, data);
      },
    };
    await match.driver
      .run(
        loggingLink,
        {
          log: (level, msg) => say(`${level.toUpperCase()}: ${msg}`),
          sensors: (values) =>
            say(`SENSORS ${values.map((v) => `${v.name ?? v.index}=${v.tempC == null ? v.status : `${v.tempC.toFixed(1)}°C/${((v.tempC * 9) / 5 + 32).toFixed(1)}°F`}`).join('  ')}`),
          status: (patch) => say(`STATUS ${JSON.stringify(patch)}`),
          reconnect: (reason) => say(`(driver asked to reconnect: ${reason})`),
          now: () => Date.now(),
        },
        match.model,
      )
      .catch((err: Error) => say(`Handshake error: ${err.message}`));
  }

  say(`Listening for ${seconds}s. Try: take a probe out of the dock, hold its tip in your hand, put it back.`);
  await sleep(seconds * 1000);
  await p.disconnectAsync().catch(() => {});
  out.end();
  console.log(`\nSaved to ${file}\nShare that file with Claude Code if your thermometer isn't reading correctly.`);
  noble.stop?.();
  process.exit(0);
}
