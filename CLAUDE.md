# Smoke Signal: notes for Claude

Smoke Signal is a Bluetooth BBQ-thermometer hub (Inkbird INT-12-BW) plus an MCP server. It lets
Claude monitor a cook. See README.md for the user-facing picture.

- **The user wants to cook, or asks about their cook** → use the `pitmaster` skill and the
  `smoke-signal` MCP tools.
- **The thermometer won't connect or reads wrong** → use the `thermometer-lab` skill.
- **The hub must run in the user's own Terminal** (`pnpm start`). It owns Bluetooth, and macOS
  grants Bluetooth per launching app. Don't start it yourself as a background task for a real
  cook: it dies with this session. The simulator is fine (`pnpm demo`).

## Development

- `pnpm check`: typecheck plus all tests. It must pass before committing.
- `pnpm demo`: hub + dashboard fed by the simulator at 60× speed. `pnpm status` prints the
  report Claude sees.
- No build step: Node ≥ 22.18 strips types at runtime. Use erasable TypeScript only:
  - no `enum`, `namespace` or constructor parameter properties
  - relative imports end in `.ts`
  - type-only imports use `import type`
- Temperatures are °C inside the code; convert only at the edges (`src/units.ts`).
- `src/mcp/server.ts` must never import Bluetooth code. It is spawned by Claude apps, and it
  talks to the hub over HTTP.
- The protocol parsers are pure and tested against captured bytes (`test/inkbird-bw.test.ts`).
  Add real frames to the tests whenever you change a parser.
- Keep `get_cook_report` output compact. A long cook calls it ~150 times.
