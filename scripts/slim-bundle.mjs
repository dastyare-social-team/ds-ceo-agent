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
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

/**
 * The ffmpeg binary must be declared in the output package.json.
 *
 * The Mastra deployer writes its own dependency list from what it can see the app
 * import, and the ffmpeg binary is referenced by path string rather than imported,
 * so it is invisible to that scan and does not get installed. The failure mode is
 * silent: compression reports itself unavailable and every oversized video is
 * passed through to storage, which then refuses it with "file is too big" and no
 * explanation. Vercel is linux-x64 and installs the optional dependency; this
 * machine is arm64 and skips it.
 */
// Both are needed: the wrapper resolves the platform, the linux package carries
// the binary. The wrapper is invisible to the deployer's import scan because it
// is reached through createRequire rather than a static import.
const FFMPEG_WRAPPER = '@ffmpeg-installer/ffmpeg';
const FFMPEG_LINUX = '@ffmpeg-installer/linux-x64';
const outputPkgPath = join(funcDir, 'package.json');
if (existsSync(outputPkgPath)) {
  const pkg = JSON.parse(readFileSync(outputPkgPath, 'utf8'));
  // The version comes from the app's own package.json, not from node_modules.
  // The linux package is an optional dependency that arm64 never installs, so
  // looking for it locally finds nothing and skips the declaration — which is
  // precisely the deploy where it is needed.
  const version = (() => {
    try {
      const app = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
      const declared =
        app.optionalDependencies?.[FFMPEG_LINUX] ?? app.dependencies?.[FFMPEG_LINUX];
      return declared ? declared.replace(/^[~^]/, '') : null;
    } catch {
      return null;
    }
  })();
  const app = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
  const pick = (name) =>
    (app.optionalDependencies?.[name] ?? app.dependencies?.[name])?.replace(/^[~^]/, '');

  const wrapper = pick(FFMPEG_WRAPPER);
  const linux = version ?? pick(FFMPEG_LINUX);
  if (wrapper || linux) {
    pkg.dependencies = { ...(pkg.dependencies ?? {}) };
    if (wrapper) pkg.dependencies[FFMPEG_WRAPPER] = `^${wrapper}`;
    if (linux) pkg.dependencies[FFMPEG_LINUX] = `^${linux}`;
    writeFileSync(outputPkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    const parts = [wrapper && `${FFMPEG_WRAPPER}@${wrapper}`, linux && `${FFMPEG_LINUX}@${linux}`];
    console.log(`  declared : ${parts.filter(Boolean).join(', ')} (installed on the deploy host)`);
  } else {
    console.log('  note     : ffmpeg not declared in package.json, so the deploy host has no binary');
  }
}

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
