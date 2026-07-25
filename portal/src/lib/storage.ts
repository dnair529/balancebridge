import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { config } from '../config.js';

/**
 * File storage rules (spec §5):
 * - files live in UPLOADS_DIR, OUTSIDE the web root; nothing static serves it
 * - on-disk name is a random uuid — the original filename exists only in DB
 * - extension allowlist + 25MB cap
 * - sha256 recorded for integrity/audit
 */

export async function ensureUploadsDir(): Promise<void> {
  await fsp.mkdir(config.uploadsDir, { recursive: true });
}

export function extensionOf(filename: string): string {
  return path.extname(filename).slice(1).toLowerCase();
}

export function isAllowedExtension(filename: string): boolean {
  return config.upload.allowedExtensions.has(extensionOf(filename));
}

export class FileTooLargeError extends Error {
  constructor() {
    super('File exceeds the 25MB limit');
  }
}

export interface StoredFile {
  storedName: string;
  sizeBytes: number;
  sha256: string;
}

/**
 * Stream an incoming file to disk under a fresh uuid, hashing and counting
 * bytes as it goes. Enforces the size cap even if the multipart limit is
 * bypassed. Cleans up the partial file on any failure.
 */
export async function saveStream(source: Readable): Promise<StoredFile> {
  const storedName = crypto.randomUUID();
  const dest = path.join(config.uploadsDir, storedName);
  const hash = crypto.createHash('sha256');
  let sizeBytes = 0;

  try {
    const out = fs.createWriteStream(dest, { flags: 'wx', mode: 0o600 });
    await pipeline(
      source,
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          sizeBytes += chunk.length;
          if (sizeBytes > config.upload.maxBytes) throw new FileTooLargeError();
          hash.update(chunk);
          yield chunk;
        }
      },
      out,
    );
  } catch (err) {
    await fsp.rm(dest, { force: true });
    throw err;
  }

  return { storedName, sizeBytes, sha256: hash.digest('hex') };
}

/** Write an in-memory buffer (e.g. a signed PDF fetched from DocuSeal). */
export async function saveBuffer(buf: Buffer): Promise<StoredFile> {
  const storedName = crypto.randomUUID();
  await fsp.writeFile(path.join(config.uploadsDir, storedName), buf, { mode: 0o600 });
  return {
    storedName,
    sizeBytes: buf.length,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
  };
}

/** Readable stream for the download route. storedName is always a DB-sourced uuid. */
export function openStored(storedName: string): fs.ReadStream {
  // Defense in depth: even though storedName comes from our own DB, refuse
  // anything that isn't a bare uuid so path traversal is structurally impossible.
  if (!/^[0-9a-f-]{36}$/i.test(storedName)) {
    throw new Error('invalid stored name');
  }
  return fs.createReadStream(path.join(config.uploadsDir, storedName));
}

export async function deleteStored(storedName: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(storedName)) return;
  await fsp.rm(path.join(config.uploadsDir, storedName), { force: true });
}
