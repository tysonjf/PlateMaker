#!/usr/bin/env node
// Entry point: checks Node can run the TypeScript sources directly (type stripping, Node ≥ 22.18),
// then hands over to src/cli.ts. Kept as plain JS so older Node versions get a readable error.
const [major, minor] = process.versions.node.split('.').map(Number);
const ok = Boolean(process.features?.typescript) || major >= 24 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);
if (!ok) {
  console.error(
    `Smoke Signal needs Node.js 22.18 or newer (this is ${process.version}).\n` +
      'Install the current LTS: `brew install node` (or `fnm install --lts` / `nvm install --lts`), then try again.',
  );
  process.exit(1);
}
await import('../src/cli.ts');
