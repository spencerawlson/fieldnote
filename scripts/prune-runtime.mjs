#!/usr/bin/env node
/**
 * Builds the runtime dependency tree for the desktop bundle.
 *
 * The workspace `node_modules` holds everything the project needs to *develop*:
 * Vite, esbuild, TypeScript, React and the type packages. None of it is needed
 * to *run* the backend — the interface is pre-built into `web/dist` — and all
 * of it would otherwise be compressed into the installer.
 *
 * This walks the server's declared dependencies transitively and copies only
 * that closure into `desktop/runtime/node_modules`. No network access, no
 * second install, and the result is deterministic from what is on disk.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'node_modules');
const TARGET = join(ROOT, 'desktop', 'runtime', 'node_modules');

function log(message) {
  process.stdout.write(`[prune-runtime] ${message}\n`);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Resolves a package directory the way Node does: check the workspace root
 * first, then any nested node_modules belonging to the dependent.
 */
function packageDir(name, fromDir) {
  const nested = join(fromDir, 'node_modules', name);
  if (existsSync(join(nested, 'package.json'))) return nested;
  const hoisted = join(SOURCE, name);
  if (existsSync(join(hoisted, 'package.json'))) return hoisted;
  return null;
}

/** Transitive closure of runtime dependencies, breadth-first. */
function collect(entryManifests) {
  const seen = new Set();
  const queue = [];

  for (const manifest of entryManifests) {
    for (const name of Object.keys(manifest.dependencies ?? {})) queue.push({ name, from: SOURCE });
    for (const name of Object.keys(manifest.optionalDependencies ?? {})) queue.push({ name, from: SOURCE });
  }

  while (queue.length > 0) {
    const { name, from } = queue.shift();
    if (seen.has(name)) continue;

    const dir = packageDir(name, from);
    if (!dir) {
      // Optional dependencies legitimately go missing (sharp on an
      // unsupported platform); a hard failure here would be wrong.
      log(`skipped ${name} (not installed)`);
      continue;
    }
    seen.add(name);

    const manifest = readJson(join(dir, 'package.json'));
    if (!manifest) continue;
    for (const dep of Object.keys(manifest.dependencies ?? {})) queue.push({ name: dep, from: dir });
    for (const dep of Object.keys(manifest.optionalDependencies ?? {})) queue.push({ name: dep, from: dir });
  }

  return seen;
}

/** Changes to the lockfile mean the installed tree may differ. */
function lockfileStamp() {
  const lock = join(ROOT, 'package-lock.json');
  if (!existsSync(lock)) return 'no-lockfile';
  return createHash('sha256').update(readFileSync(lock)).digest('hex').slice(0, 16);
}

function directorySize(path) {
  let total = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) total += statSync(full).size;
    }
  };
  if (existsSync(path)) walk(path);
  return total;
}

/**
 * Directories inside a published package that no runtime ever needs.
 *
 * Beyond the wasted space, one of these actively broke a build target: the
 * MSI linker encodes file paths in code page 1252, and @fastify/send ships a
 * test fixture named "snow ☃". A snowman in a test directory is not worth a
 * broken installer.
 */
const JUNK_DIRECTORIES = new Set([
  'test',
  'tests',
  '__tests__',
  'fixtures',
  '__fixtures__',
  'example',
  'examples',
  'benchmark',
  'benchmarks',
  'coverage',
  'docs',
  '.github',
  '.nyc_output',
]);

/** Bump when the filter changes, so a stale manifest does not skip the rebuild. */
const FILTER_VERSION = 2;

function keepPath(source) {
  const name = basename(source);
  if (JUNK_DIRECTORIES.has(name)) return false;
  // Source maps are dead weight in a shipped runtime.
  if (name.endsWith('.map')) return false;
  return true;
}

export function pruneRuntime() {
  const server = readJson(join(ROOT, 'server', 'package.json'));
  if (!server) throw new Error('server/package.json not found');

  const needed = collect([server]);
  log(`${needed.size} runtime packages required`);

  // Rebuilding the tree unconditionally would delete files Tauri is in the
  // middle of enumerating if two builds overlap, and it costs a 93 MB copy on
  // every run. A manifest of what was last written makes the step a no-op when
  // nothing has changed.
  const manifestPath = join(dirname(TARGET), 'manifest.json');
  const manifest = { packages: [...needed].sort(), lockHash: lockfileStamp(), filterVersion: FILTER_VERSION };
  const existing = readJson(manifestPath);
  if (
    existing &&
    existing.lockHash === manifest.lockHash &&
    existing.filterVersion === manifest.filterVersion &&
    JSON.stringify(existing.packages) === JSON.stringify(manifest.packages) &&
    existsSync(join(TARGET, 'fastify'))
  ) {
    log('runtime tree already current');
    return TARGET;
  }

  rmSync(TARGET, { recursive: true, force: true });
  mkdirSync(TARGET, { recursive: true });

  for (const name of needed) {
    const from = join(SOURCE, name);
    if (!existsSync(from)) continue;
    const to = join(TARGET, name);
    mkdirSync(dirname(to), { recursive: true });
    // dereference: false keeps symlinked workspace packages as links rather
    // than duplicating them; there are none today, but it stays correct if
    // a shared package is added later.
    cpSync(from, to, { recursive: true, dereference: false, filter: keepPath });
  }

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const before = directorySize(SOURCE);
  const after = directorySize(TARGET);
  log(
    `runtime tree: ${Math.round(after / 1e6)} MB (from ${Math.round(before / 1e6)} MB installed — ` +
      `${Math.round((1 - after / before) * 100)}% smaller)`,
  );
  return TARGET;
}

// pathToFileURL rather than string-building: on Windows a drive letter makes
// `file://C:/…` differ from Node's `file:///C:/…`, so a hand-built comparison
// silently never matches and the script does nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  pruneRuntime();
}
