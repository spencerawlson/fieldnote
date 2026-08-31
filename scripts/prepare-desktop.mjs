#!/usr/bin/env node
/**
 * Prepares the desktop bundle.
 *
 *  1. Builds the web interface if it is missing or stale.
 *  2. Copies the running Node runtime in as a Tauri sidecar, named with the
 *     target triple Tauri expects.
 *
 * Node is bundled rather than assumed: an installable desktop app cannot
 * require its users to have a matching Node version on PATH, and the backend
 * relies on Node 24 features (node:sqlite, native TypeScript execution).
 */

import { execFileSync, execSync } from 'node:child_process';
import { copyFileSync, existsSync, linkSync, mkdirSync, rmSync, statSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pruneRuntime } from './prune-runtime.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = join(ROOT, 'desktop');

function log(message) {
  process.stdout.write(`[prepare-desktop] ${message}\n`);
}

/** `rustc -vV` reports the host triple Tauri will look for. */
function hostTriple() {
  try {
    const output = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
    const match = output.match(/^host:\s*(\S+)$/m);
    if (match) return match[1];
  } catch {
    /* fall through to a platform guess */
  }
  const guess = {
    win32: 'x86_64-pc-windows-msvc',
    darwin: process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin',
    linux: process.arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu',
  }[process.platform];
  if (!guess) throw new Error(`Unsupported platform: ${process.platform}`);
  return guess;
}

function newestMtime(dir) {
  let newest = 0;
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else newest = Math.max(newest, statSync(full).mtimeMs);
    }
  };
  walk(dir);
  return newest;
}

function buildWebIfNeeded() {
  const dist = join(ROOT, 'web', 'dist', 'index.html');
  const src = join(ROOT, 'web', 'src');
  const needsBuild = !existsSync(dist) || statSync(dist).mtimeMs < newestMtime(src);
  if (!needsBuild) {
    log('web/dist is up to date');
    return;
  }
  log('building the web interface…');
  execSync('npm run build --workspace=web', { cwd: ROOT, stdio: 'inherit' });
}

/**
 * Which triples the sidecar must be named for.
 *
 * `cargo` looks for the rustc host triple, but the Windows bundler asks for the
 * MSVC triple regardless of which toolchain compiled the binary. Providing both
 * names means the build works on either toolchain; the second name is a hard
 * link, so it costs no extra disk.
 */
function sidecarTriples() {
  const host = hostTriple();
  const triples = new Set([host]);
  if (process.platform === 'win32') {
    triples.add(process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc');
  }
  return [...triples];
}

function copyNodeSidecar() {
  const extension = process.platform === 'win32' ? '.exe' : '';
  const source = process.execPath;
  const sourceSize = statSync(source).size;
  const dir = join(DESKTOP, 'binaries');
  mkdirSync(dir, { recursive: true });

  let primary = null;
  for (const triple of sidecarTriples()) {
    const name = `node-${triple}${extension}`;
    const target = join(dir, name);

    if (existsSync(target) && statSync(target).size === sourceSize) {
      log(`sidecar present: ${name}`);
      primary ??= target;
      continue;
    }

    rmSync(target, { force: true });
    if (primary) {
      // Hard link the alias rather than copying ~90 MB twice.
      try {
        linkSync(primary, target);
        log(`sidecar alias: ${name}`);
        continue;
      } catch {
        /* different volume or unsupported — fall through to a copy */
      }
    }
    copyFileSync(source, target);
    primary ??= target;
    log(`bundled Node ${process.version} as ${name} (${Math.round(sourceSize / 1e6)} MB)`);
  }
}

/**
 * Stages WebView2Loader.dll next to the bundle resources.
 *
 * The MSVC toolchain links the WebView2 loader statically and Tauri's bundler
 * assumes that. The GNU toolchain links it dynamically instead, so an installed
 * build fails at launch with
 * "error while loading shared libraries: WebView2Loader.dll". Shipping the DLL
 * makes a GNU-toolchain build installable; it is harmless on MSVC, where the
 * file simply is not produced and this becomes a no-op.
 */
function stageWebView2Loader() {
  if (process.platform !== 'win32') return;

  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const candidates = [
    join(DESKTOP, 'target', 'release', 'WebView2Loader.dll'),
    join(DESKTOP, 'target', 'debug', 'WebView2Loader.dll'),
  ];

  // Fall back to the copy the webview2-com-sys build script unpacks.
  const buildRoot = join(DESKTOP, 'target', 'release', 'build');
  if (existsSync(buildRoot)) {
    for (const entry of readdirSync(buildRoot)) {
      if (!entry.startsWith('webview2-com-sys-')) continue;
      candidates.push(join(buildRoot, entry, 'out', arch, 'WebView2Loader.dll'));
    }
  }

  const source = candidates.find((candidate) => existsSync(candidate));
  if (!source) {
    log('WebView2Loader.dll not found — assuming a static link (MSVC toolchain)');
    return;
  }

  const target = join(DESKTOP, 'runtime', 'WebView2Loader.dll');
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target) && statSync(target).size === statSync(source).size) {
    log('WebView2Loader.dll already staged');
    return;
  }
  copyFileSync(source, target);
  log(`staged WebView2Loader.dll (${arch})`);
}

function checkNodeVersion() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 24) {
    throw new Error(
      `The bundled runtime must be Node 24 or newer (found ${process.version}). ` +
        'The backend uses node:sqlite and native TypeScript execution.',
    );
  }
}

checkNodeVersion();
// Order matters: the interface must be built before the runtime tree is
// assembled, because Tauri snapshots the resource file list at the start of
// bundling. Rebuilding web/dist afterwards leaves the manifest pointing at
// hashed filenames that no longer exist.
buildWebIfNeeded();
pruneRuntime();
stageWebView2Loader();
copyNodeSidecar();
log('ready');
