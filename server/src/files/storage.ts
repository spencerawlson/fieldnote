import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { config } from '../config.ts';
import { AppError } from '../lib/core.ts';

/**
 * Storage driver interface.
 *
 * Files are addressed by opaque keys, never by user-supplied paths, and the
 * uploads directory is never served statically — every read goes through an
 * authorised route. Swapping in S3 or Azure Blob means implementing this
 * interface; nothing else in the codebase touches the filesystem for uploads.
 */
export interface StorageDriver {
  readonly name: string;
  writeStream(key: string, stream: Readable): Promise<number>;
  writeBuffer(key: string, data: Buffer): Promise<number>;
  read(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  size(key: string): Promise<number>;
}

class LocalDriver implements StorageDriver {
  readonly name = 'local';
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /** Resolves a key inside the storage root, refusing anything that escapes it. */
  private path(key: string): string {
    if (!/^[A-Za-z0-9/_.-]+$/.test(key) || key.includes('..')) {
      throw new AppError(400, 'invalid_key', 'Invalid storage key');
    }
    const full = resolve(this.root, normalize(key));
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new AppError(400, 'invalid_key', 'Storage key escapes the storage root');
    }
    return full;
  }

  async writeStream(key: string, stream: Readable): Promise<number> {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    let bytes = 0;
    stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
    });
    await pipeline(stream, createWriteStream(target, { mode: 0o600 }));
    return bytes;
  }

  async writeBuffer(key: string, data: Buffer): Promise<number> {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data, { mode: 0o600 });
    return data.length;
  }

  async read(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }

  async remove(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.path(key));
      return true;
    } catch {
      return false;
    }
  }

  async size(key: string): Promise<number> {
    const info = await stat(this.path(key));
    return info.size;
  }
}

let driver: StorageDriver | null = null;

export function getStorage(): StorageDriver {
  if (!driver) {
    switch (config.storage.driver) {
      case 'local':
      default:
        driver = new LocalDriver(config.storage.path);
        break;
    }
  }
  return driver;
}

export function setStorage(next: StorageDriver | null): void {
  driver = next;
}

export function readFileBytes(key: string): Promise<Buffer> {
  return getStorage().read(key);
}

/** Keys are namespaced by project so a project delete is a prefix delete. */
export function buildStorageKey(projectId: string, fileId: string, extension: string): string {
  const safeExt = extension.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase();
  return join('projects', projectId, `${fileId}${safeExt ? `.${safeExt}` : ''}`).split(sep).join('/');
}

export function buildThumbKey(projectId: string, fileId: string): string {
  return join('projects', projectId, 'thumbs', `${fileId}.webp`).split(sep).join('/');
}

export function buildExportKey(projectId: string, exportId: string, extension: string): string {
  return join('projects', projectId, 'exports', `${exportId}.${extension}`).split(sep).join('/');
}
