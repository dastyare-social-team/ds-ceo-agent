/**
 * Vercel rejects a Node function over 250MB uncompressed, and it does that at
 * deploy time, after the build has already run. This checks it locally first.
 *
 *   npm run check:bundle
 *
 * The local Whisper stack is the reason this exists: inference backends are
 * large, and adding one silently pushed the function well past the limit.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const LIMIT_MB = 250;
const outputDir = '.vercel/output';

if (!existsSync(outputDir)) {
  console.error('No .vercel/output — run `npm run build` first.');
  process.exit(1);
}

const functionsDir = join(outputDir, 'functions');
if (!existsSync(functionsDir)) {
  console.error('No .vercel/output/functions — run `npm run build` first.');
  process.exit(1);
}

function megabytes(bytes) {
  return bytes / 1024 / 1024;
}

function dirSize(path) {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      total += dirSize(child);
      continue;
    }
    try {
      // lstat, not stat: .bin holds symlinks that can dangle in a pruned tree.
      total += lstatSync(child).size;
    } catch {
      // A dangling symlink contributes nothing; do not fail the size check.
    }
  }
  return total;
}

const functions = readdirSync(functionsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

let failed = false;
for (const name of functions) {
  const path = join(functionsDir, name);
  const sizeMb = megabytes(dirSize(path));
  const verdict = sizeMb > LIMIT_MB ? 'TOO BIG' : 'ok';
  console.log(`  ${name.padEnd(24)} ${sizeMb.toFixed(1).padStart(7)} MB  / ${LIMIT_MB} MB  ${verdict}`);
  if (sizeMb > LIMIT_MB) failed = true;
}

if (failed) {
  console.error(
    '\nVercel will reject this build on function size. Trim the largest entries:\n' +
      '  du -sh .vercel/output/functions/*/node_modules/* | sort -rh | head',
  );
  process.exit(1);
}
console.log('\nAll functions are within the Vercel size limit.');
