import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline as pipelineCb } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { config } from '../config.js';
import {
  ENVELOPE_OVERHEAD,
  currentKeyVersion,
  decryptBuffer,
  decryptStream,
  encryptBuffer,
  encryptStream,
  isEncrypted,
  keyVersionOf,
} from './crypto.js';

/**
 * File storage rules (spec §5):
 * - files live in UPLOADS_DIR, OUTSIDE the web root; nothing static serves it
 * - on-disk name is a random uuid — the original filename exists only in DB
 * - extension allowlist + 25MB cap
 * - sha256 recorded for integrity/audit
 *
 * ENCRYPTION AT REST (added in the security hardening pass):
 * every byte written here goes through the AES-256-GCM envelope in
 * ./crypto.ts, so the uploads volume — and every backup of it — is useless
 * without FILE_ENCRYPTION_KEY. The API shape is unchanged; callers still get a
 * plaintext stream/buffer and a plaintext sha256.
 *
 *   * `sha256` and `sizeBytes` describe the ORIGINAL bytes, not the ciphertext.
 *     That keeps the integrity record meaningful (it survives a key rotation)
 *     and keeps the download route's Content-Length correct.
 *   * `encryptedBytes` is what the file actually occupies (plaintext + 97).
 *   * `keyVersion` is the KEK key id the file was sealed with. The
 *     authoritative copy lives in the file header; this is returned so callers
 *     can record it (see SECURITY.md — a documents.encryption_key_version
 *     column is a proposed follow-up owned by the schema author).
 *   * Reads sniff the magic bytes: files written before this change are still
 *     plaintext on disk and stream through untouched. `reencryptStored()`
 *     upgrades them in place.
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
  /** Plaintext length — what the download route reports as Content-Length. */
  sizeBytes: number;
  /** sha256 of the PLAINTEXT, so integrity is independent of the key in use. */
  sha256: string;
  /** Always true for new writes; kept explicit so callers never have to assume. */
  encrypted: boolean;
  /** KEK key id (hex) that sealed this file — see crypto.ts header layout. */
  keyVersion: string;
  /** Bytes actually consumed on disk (plaintext + 97 bytes of envelope). */
  encryptedBytes: number;
}

/** storedName is always a DB-sourced uuid; refuse anything else, always. */
function resolveStored(storedName: string): string {
  // Defense in depth: even though storedName comes from our own DB, refuse
  // anything that isn't a bare uuid so path traversal is structurally impossible.
  if (!/^[0-9a-f-]{36}$/i.test(storedName)) {
    throw new Error('invalid stored name');
  }
  return path.join(config.uploadsDir, storedName);
}

/**
 * Stream an incoming file to disk under a fresh uuid, hashing and counting
 * PLAINTEXT bytes as it goes, then encrypting before it touches the disk.
 * Enforces the size cap even if the multipart limit is bypassed. Cleans up the
 * partial file on any failure.
 */
export async function saveStream(source: Readable): Promise<StoredFile> {
  const storedName = crypto.randomUUID();
  const dest = resolveStored(storedName);
  const hash = crypto.createHash('sha256');
  const keyVersion = currentKeyVersion();
  let sizeBytes = 0;

  try {
    const out = fs.createWriteStream(dest, { flags: 'wx', mode: 0o600 });
    await pipeline(
      source,
      // Measure + hash the plaintext BEFORE encryption: the cap applies to what
      // the user actually sent, and the hash stays comparable across rotations.
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          sizeBytes += chunk.length;
          if (sizeBytes > config.upload.maxBytes) throw new FileTooLargeError();
          hash.update(chunk);
          yield chunk;
        }
      },
      encryptStream(),
      out,
    );
  } catch (err) {
    await fsp.rm(dest, { force: true });
    throw err;
  }

  return {
    storedName,
    sizeBytes,
    sha256: hash.digest('hex'),
    encrypted: true,
    keyVersion,
    encryptedBytes: sizeBytes + ENVELOPE_OVERHEAD,
  };
}

/** Write an in-memory buffer (e.g. a signed PDF fetched from DocuSeal). */
export async function saveBuffer(buf: Buffer): Promise<StoredFile> {
  if (buf.length > config.upload.maxBytes) throw new FileTooLargeError();
  const storedName = crypto.randomUUID();
  const keyVersion = currentKeyVersion();
  const sealed = encryptBuffer(buf);
  await fsp.writeFile(resolveStored(storedName), sealed, { mode: 0o600 });
  return {
    storedName,
    sizeBytes: buf.length,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    encrypted: true,
    keyVersion,
    encryptedBytes: sealed.length,
  };
}

/**
 * Readable PLAINTEXT stream for the download route. storedName is always a
 * DB-sourced uuid. The returned stream is the tail of a pipeline, so a read
 * error or a failed auth tag destroys it (the client sees a truncated
 * response) instead of silently serving corrupt bytes.
 */
export function openStored(storedName: string): Readable {
  const src = fs.createReadStream(resolveStored(storedName));
  // pipeline() returns the destination and wires up error propagation both
  // ways; .pipe() would leak the source fd and hang the reply on error.
  return pipelineCb(src, decryptStream(), () => {
    /* errors surface on the returned stream; the route logs them */
  });
}

/** Read a stored file fully into memory as plaintext. */
export async function readStored(storedName: string): Promise<Buffer> {
  const raw = await fsp.readFile(resolveStored(storedName));
  return isEncrypted(raw) ? decryptBuffer(raw) : raw;
}

export async function deleteStored(storedName: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(storedName)) return;
  await fsp.rm(path.join(config.uploadsDir, storedName), { force: true });
}

export interface ReencryptResult {
  storedName: string;
  /** 'encrypted' = was plaintext, now sealed. 'rewrapped' = sealed under the current KEK. */
  action: 'encrypted' | 'rewrapped' | 'skipped';
  keyVersion: string;
}

/**
 * Re-seal a stored file under the CURRENT KEK. Used for two things:
 *   1. upgrading files written before encryption shipped, and
 *   2. finishing a key rotation, so FILE_ENCRYPTION_KEY_PREVIOUS can be retired.
 *
 * Writes to a temp file and renames, so a crash mid-rewrite never destroys the
 * original. Skips files already sealed under the current key unless forced.
 */
export async function reencryptStored(storedName: string, force = false): Promise<ReencryptResult> {
  const file = resolveStored(storedName);
  const raw = await fsp.readFile(file);
  const target = currentKeyVersion();

  const wasEncrypted = isEncrypted(raw);
  if (wasEncrypted && !force && keyVersionOf(raw) === target) {
    return { storedName, action: 'skipped', keyVersion: target };
  }

  const plain = wasEncrypted ? decryptBuffer(raw) : raw;
  const tmp = `${file}.rekey.${process.pid}`;
  await fsp.writeFile(tmp, encryptBuffer(plain), { mode: 0o600, flag: 'wx' });
  await fsp.rename(tmp, file);
  return { storedName, action: wasEncrypted ? 'rewrapped' : 'encrypted', keyVersion: target };
}
