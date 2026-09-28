/**
 * Strips files from the built function that are dead weight at runtime.
 *
 * The Mastra Vercel deployer copies whole packages into the function, so the
 * bundle carries 1130 sourcemaps and 1054 type declarations from @mastra/core
 * that are never read when the function runs. Sourcemaps alone are 69MB.
 *
 * Run after `npm run build`, before deploy:
 *   node scripts/slim-bundle.mjs
 *
 * This used to also declare and copy the local voice packages into the output,
 * because the deployer omits packages the app imports and that surfaced only as a
 * bare "Cannot find module" on Vercel. Voice is now a hosted HTTP call with no
 * runtime packages of its own, so that whole section is gone with the engine.
 *
 * Only sourcemaps and type declarations are removed. Two things are deliberately
 * left alone:
 *
 *   - The TypeScript compiler (24MB). It arrives via typescript-paths, which the
 *     deployer uses at build time to resolve path aliases. No shipped module
 *     imports it, but Mastra's provider-registry probes for TypeScript at runtime
 *     and builds paths like `<cache>/provider-types.generated.d.ts`, so removing
 *     the compiler and its lib files together is the one change here that would
 *     need a real deploy to prove safe. 24MB is not worth guessing over.
 *
 *   - JavaScript source files. Only the .map and .d.ts sidecars go.
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const funcDir = resolve(process.argv[2] ?? '.vercel/output/functions/index.func');
if (!existsSync(funcDir)) {
  console.error('No built function. Run `npm run build` first.');
  process.exit(1);
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
    } else {
      try {
        total += statSync(child).size;
      } catch {
        // A dangling symlink contributes nothing.
      }
    }
  }
  return total;
}

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);
const before = dirSize(funcDir);

function pruneFiles(root, predicate) {
  let bytes = 0;
  let count = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const child = join(root, entry.name);
    if (entry.isDirectory()) {
      const sub = pruneFiles(child, predicate);
      bytes += sub.bytes;
      count += sub.count;
    } else if (predicate(entry.name)) {
      try {
        bytes += statSync(child).size;
        rmSync(child, { force: true });
        count += 1;
      } catch {
        // Not removable: it is only a size optimisation, so carry on.
      }
    }
  }
  return { bytes, count };
}

const nodeModules = join(funcDir, 'node_modules');

// Sourcemaps. Only read by a debugger attaching to a stack trace.
const maps = pruneFiles(nodeModules, (name) => name.endsWith('.map'));
// Type declarations. Only read by a TypeScript compiler, which is not shipped.
const types = pruneFiles(nodeModules, (name) => name.endsWith('.d.ts') || name.endsWith('.d.mts'));

const after = dirSize(funcDir);
console.log(`  before    : ${mb(before)} MB`);
console.log(`  sourcemaps: ${mb(maps.bytes)} MB (${maps.count} files)`);
console.log(`  .d.ts     : ${mb(types.bytes)} MB (${types.count} files)`);
console.log(`  after     : ${mb(after)} MB`);

// Fail loudly rather than shipping a bundle that cannot boot.
const entry = join(funcDir, 'index.mjs');
if (existsSync(entry)) {
  const source = readFileSync(entry, 'utf8');
  if (/\bfrom\s*['"]typescript['"]\b|\brequire\(['"]typescript['"]\)/.test(source)) {
    console.error('\n  The entry imports typescript directly; report this before deploying.');
    process.exit(1);
  }
}
