---
name: thermometer-lab
description: Diagnose and fix Smoke Signal's Bluetooth connection to a thermometer, or teach it a new model. Use when the hub can't find or connect to the Inkbird, readings look wrong (swapped probes, crazy values, °F/°C confusion, a probe always missing), the device keeps reconnecting, or the user wants to add a different Bluetooth thermometer.
---

# Thermometer lab

This skill is for working on the Smoke Signal codebase on the user's Mac. The Bluetooth code:

- `src/devices/ble.ts`: scanning, connecting, reconnect/backoff (via `@stoprocent/noble`, CoreBluetooth).
- `src/devices/protocols/inkbird-bw.ts`: INT-12-BW protocol (auth handshake, frame parsing).
  The protocol is documented in `docs/inkbird-int-12-bw-protocol.md`.
- `src/devices/protocols/ibbq.ts`: classic iBBQ protocol (IBT-2X/4XS/6XS).
- `src/devices/protocols/index.ts`: driver registry (name matching).
- `test/inkbird-bw.test.ts`: real captured handshake vectors and a fake base. Extend it with
  any real frames you capture.

## macOS rule

Bluetooth access belongs to the app that launched the process.

- Commands started from **Terminal / iTerm / VS Code's terminal** (including Claude Code running
  in that terminal) work, once that app is allowed under System Settings → Privacy & Security →
  Bluetooth.
- Commands launched by the Claude **desktop app** may be blocked. If a scan fails with
  "unauthorized" or silently finds nothing, ask the user to run the command in Terminal and
  paste the output.

## Workflow

1. **Is the hub the problem?** Run `pnpm status`. The Devices line shows the state and the last
   error. The hub's terminal shows connection logs; `pnpm start --verbose` adds protocol
   frames.
2. **Can the Mac see it?** Run `pnpm scan` (15 s, or `--all` for every device).
   - The INT-12-BW advertises as `Int12bw` / `INT-12-BW`.
   - Not listed:
     - The INKBIRD phone app is holding the connection; close it fully.
     - The base is asleep; take a probe out.
     - The Mac is out of range.
     - Bluetooth permission is missing.
   - Listed but not ✔: the name doesn't match `matchName()` in `inkbird-bw.ts`. Add the
     advertised name, plus a test.
3. **Dump the conversation.** Run `pnpm explore` (or `pnpm explore <name-or-id> --seconds 120`).
   - While it runs, have the user take probes out of the dock, hold a probe tip in their hand
     (about 32–35 °C), and put it back.
   - The log is saved to `~/.smoke-signal/explore-*.log` and holds the GATT table, every
     read/notify in hex with "plausible int16/10" decodes, the handshake writes and the decoded
     sensors.
4. **Interpret it** against `docs/inkbird-int-12-bw-protocol.md`:
   - **Handshake:**
     - Look for `WRITE ff02 01 fb`, then a `NOTIFY ff02 07 fb …`, then our `08 fc …`, then
       `02 fc 00` (accepted).
     - Status `01` means rejected: check `verifyBody()` against the test vectors.
     - A drop after ~30 s means the auth isn't being accepted.
   - **Temperatures:**
     - FF01 is int16 LE °C×10. The INT-12-BW sends 10 bytes: black tip @0, black ambient @2,
       white tip @5.
     - If the length or offsets differ on this firmware, find the bytes that track the
       hand-warming, and fix `parseTemps()`.
     - Sentinels are 32766/32767/-32768.
   - **Dock state:** FF03 bit 0 = connected, bit 1 = docked, one 16-bit block per probe.
5. **Fix with a test first.**
   - Paste the captured frames into `test/inkbird-bw.test.ts` as a new case with the expected
     values.
   - Update the parser, then run `pnpm check` (typecheck plus tests).
6. **Verify live** with `pnpm start` and watch the terminal status block. For a new model,
   add a driver in `src/devices/protocols/` and register it in `index.ts`.

Keep changes minimal and never remove the fake-base tests. If you learn something new about the
protocol, add it to the protocol doc with the firmware version you saw it on.
