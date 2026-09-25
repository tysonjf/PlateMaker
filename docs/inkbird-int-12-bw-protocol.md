# Inkbird INT-12-BW Bluetooth protocol (as implemented)

Smoke Signal's driver (`src/devices/protocols/inkbird-bw.ts`) is an independent TypeScript
implementation of the protocol **reverse-engineered and documented by Paul Faure** in
[paul43210/inkbird-bw-ble](https://github.com/paul43210/inkbird-bw-ble) (BLE captures plus the
decompiled INKBIRD Android app, verified on INT-12-BW firmware V1.2.7). That repository is the
authoritative write-up; this page summarises what we rely on.

## Hardware

- One **base station** (display, battery, Wi-Fi + Bluetooth) and **two wireless probes** that
  charge in the base.
- **Black probe**: tip sensor plus an ambient sensor in the handle. **White probe**: tip only.
- The computer talks Bluetooth LE **to the base**; the probes talk to the base.
- **Only one Bluetooth central at a time.** Close the INKBIRD phone app, which may still work over
  Wi-Fi.
- It advertises as `Int12bw` (some sources: `INT-12-BW`), and goes quiet when idle. Take a probe
  out to wake it.

## GATT (service `0xFF00`)

| Char | Properties | Content |
|---|---|---|
| FF01 | read, notify | temperatures |
| FF02 | read, write, notify | control channel (commands in, reports out) |
| FF03 | read, notify | probe state bits |
| FF04–FF06 | notify | alarm/event pushes (not decoded) |
| 2A19 | read, notify | battery `[base %, probe1 %, probe2 %]`, `0x7F` = n/a |

## FF02 framing

Every payload is one or more frames: `<LEN><TYPE><payload…>`, where LEN counts TYPE plus the
payload. A "set" of type N is reported back as type N+1.

## Session

1. Subscribe to FF01, FF02, FF03 and 2A19.
2. Write `01 FB` to FF02. The base notifies `07 FB <6-byte challenge>`.
3. Write `08 FC <7 bytes>`:
   - `ms_of_second` (LE16), then `epoch_seconds` (LE32), then a CRC byte.
   - CRC = `crc8_dvbs2(time6 + [crc8_dvbs2(time6), crc8_cdma2000(challenge)])`.
     - DVB-S2: poly 0xD5, init 0x00.
     - CDMA2000: poly 0x9B, init 0xFF.
     - Both MSB-first, no reflection.
   - The base answers `02 FC 00` (accepted).
   - Without this it ignores commands and drops the link after about 30 s.
4. Clock sync: `07 19 <epoch LE32> <ms LE16>`.
5. The app's "read settings" blob (unit, targets, names, info…). We send it in chunks of
   18 bytes or less, split at frame boundaries.
6. Poll `02 F1 01 02 F1 03 02 F1 19`. FF01/FF03/2A19 notifications then stream every few
   seconds; we re-poll if it goes quiet for 15 s.

The 17 captured challenge/response pairs from the reference repo are in
`test/inkbird-bw.test.ts` and all pass.

## FF01 temperatures

Signed int16 little-endian, **°C × 10**, always in °C whatever the base displays.

| Bytes | Meaning |
|---|---|
| 0–1 | black probe tip → channel **A1** (meat) |
| 2–3 | black probe ambient → channel **A2** (pit) |
| 4 | reserved |
| 5–6 | white probe tip → channel **A3** (meat) |
| 7 | reserved / frame counter byte (sources differ) |
| 8–9 | base station's own temperature |

Sentinels: `32766` error, `32767` no probe / high, `-32768` low.

The INT-14-BW sends 18 bytes (four `[tip][ambient]` pairs) and is parsed experimentally.

## FF03 probe state

Seven bytes, one 16-bit block per probe, least significant bit first:

- bit 0: connected
- bit 1: charging (docked)

So `0x03` means the probe is in the dock, and `0x01` means it's out and in use. While a probe is
docked its reading is ignored.

## Open questions (use `pnpm explore` to check on your unit)

- Exact advertised name and manufacturer data.
- The meaning of FF01 bytes 4 and 7.
- The remaining FF03 bits.
- Whether the base keeps talking to the cloud over Wi-Fi while a computer holds the Bluetooth
  link.
