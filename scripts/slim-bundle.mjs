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
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const funcDir = process.argv[2] ?? '.vercel/output/functions/index.func';
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

/**
 * The Mastra Vercel deployer writes its own dependency list into the output
 * package.json, and that list does not include everything the app imports.
 * Anything missing is installed by neither the build nor Vercel, so it fails at
 * runtime with a bare "Cannot find module" — which is how voice broke on Vercel
 * with `Cannot find module 'unbzip2-stream'`. Declare those packages here so
 * they are installed, and copy the tree across for the local check.
 */
// The Linux binary is declared explicitly, not left to optionalDependencies.
// The wrapper loads it by platform name, and an optional dep is only installed
// if npm believes the platform matches; naming it removes that guesswork and
// documents the 31MB the deploy is paying for. The other platforms stay optional
// so local development on macOS or Windows still works.
const TARGET_PLATFORM_PACKAGE = 'sherpa-onnx-linux-x64';
const VOICE_PACKAGES = [
  'sherpa-onnx-node',
  'tar-stream',
  'unbzip2-stream',
  'ogg-opus-decoder',
  TARGET_PLATFORM_PACKAGE,
];
const outputPkgPath = join(funcDir, 'package.json');

if (existsSync(outputPkgPath)) {
  const pkg = JSON.parse(readFileSync(outputPkgPath, 'utf8'));
  pkg.dependencies = { ...(pkg.dependencies ?? {}) };

  // The target binary is installed on the deploy host, not here: npm refuses to
  // install a linux package on an arm64 mac, and the local tree only has the
  // darwin one. Its version is pinned rather than read, so this works on both.
  const PINNED = { [TARGET_PLATFORM_PACKAGE]: '1.13.8' };
  const toDeclare = VOICE_PACKAGES.filter(
    (name) => existsSync(join('node_modules', name, 'package.json')),
  );
  const unavailable = VOICE_PACKAGES.filter((name) => !toDeclare.includes(name));
  if (unavailable.some((n) => !(n in PINNED))) {
    console.error(`  Not installed and not pinned: ${unavailable.join(', ')}`);
    process.exit(1);
  }

  const added = [];
  for (const name of VOICE_PACKAGES) {
    if (pkg.dependencies[name]) continue;
    const version = PINNED[name] ?? JSON.parse(
      readFileSync(join('node_modules', name, 'package.json'), 'utf8'),
    ).version;
    pkg.dependencies[name] = `^${version}`;
    added.push(`${name}@${version}`);
  }
  if (unavailable.length) {
    console.log(`  pinned  : ${unavailable.join(', ')} (installed on the deploy host)`);
  }

  writeFileSync(outputPkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`  declared : ${added.length ? added.join(', ') : '(all already declared)'}`);

  // The build does not copy these across, so do it here. This also lets the
  // bundle be booted and exercised locally instead of only on Vercel.
  for (const name of toDeclare) {
    const target = join(funcDir, 'node_modules', name);
    if (existsSync(target)) continue;
    cpSync(join('node_modules', name), target, { recursive: true, dereference: true });
    console.log(`  copied   : ${name}`);
  }
}

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
