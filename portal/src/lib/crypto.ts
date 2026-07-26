import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { config } from '../config.js';

/**
 * Envelope encryption for files at rest (AES-256-GCM).
 *
 * WHY ENVELOPE: every file gets its own random 32-byte data key (DEK). The DEK
 * is wrapped (encrypted) with the master key (KEK) from FILE_ENCRYPTION_KEY and
 * stored in the file header. Rotating the KEK therefore only requires rewriting
 * 97 bytes of header per file, never the file body — and a leaked DEK exposes
 * exactly one document.
 *
 * ROTATION: FILE_ENCRYPTION_KEY is the current KEK; FILE_ENCRYPTION_KEY_PREVIOUS
 * (optional) is kept readable during a rotation window. New writes always use
 * the current KEK. Reads resolve the KEK by the 4-byte key id in the header and
 * fall back to trying every configured KEK, so both generations decrypt.
 *
 * ON-DISK LAYOUT (little endian is not used anywhere; all fields are opaque bytes)
 *
 *   off  len  field        notes
 *   ---  ---  -----------  --------------------------------------------------
 *     0    4  magic        ASCII "BBE1"
 *     4    1  version      format version, currently 0x01
 *     5    4  keyId        sha256("bbfk1" || KEK)[0..4) — which KEK wrapped the DEK
 *     9   12  wrapIv       GCM nonce for the DEK wrap
 *    21   16  wrapTag      GCM auth tag for the DEK wrap
 *    37   32  wrappedDek   GCM ciphertext of the 32-byte DEK
 *    69   12  dataIv       GCM nonce for the payload
 *   ---  ---  header is 81 bytes and is used verbatim as AAD for the payload,
 *             so a tampered key id / IV fails authentication instead of
 *             silently decrypting to garbage.
 *    81    n  ciphertext   AES-256-GCM(payload)
 *  81+n   16  dataTag      GCM auth tag for the payload — TRAILING, not in the
 *                          header, so encryption can stream without seeking back.
 *
 * Total overhead: 97 bytes per file.
 *
 * Both buffered (`encryptBuffer`/`decryptBuffer`) and streaming
 * (`encryptStream`/`decryptStream`) paths are implemented; storage.ts uses the
 * streaming path for uploads and downloads so a 25MB file never sits in memory
 * twice. GCM is used in one-shot mode per stream: the trailing tag authenticates
 * the whole payload, so a consumer MUST NOT act on decrypted bytes before the
 * stream ends cleanly. The download route only pipes bytes to the client, and a
 * failed tag destroys the stream mid-response (truncated download, never a
 * silently corrupted file).
 */

const MAGIC = Buffer.from('BBE1', 'ascii');
const FORMAT_VERSION = 1;

const OFF_MAGIC = 0;
const OFF_VERSION = 4;
const OFF_KEY_ID = 5;
const OFF_WRAP_IV = 9;
const OFF_WRAP_TAG = 21;
const OFF_WRAPPED_DEK = 37;
const OFF_DATA_IV = 69;

export const HEADER_LEN = 81;
export const TAG_LEN = 16;
const IV_LEN = 12;
const KEY_LEN = 32;
/** Bytes of overhead added to every encrypted file (header + trailing tag). */
export const ENVELOPE_OVERHEAD = HEADER_LEN + TAG_LEN;

/** Wrapping the DEK is authenticated over magic+version+keyId+wrapIv. */
const WRAP_AAD_LEN = OFF_WRAP_TAG; // 21

export class DecryptionError extends Error {
  constructor(message: string) {
    // Deliberately vague: never echo key material or plaintext in an error.
    super(`file decryption failed: ${message}`);
    this.name = 'DecryptionError';
  }
}

export class KeyConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyConfigurationError';
  }
}

interface Kek {
  /** Hex key id, also what we surface as `keyVersion` in metadata. */
  id: string;
  idBytes: Buffer;
  key: Buffer;
  label: 'current' | 'previous';
}

function decodeKek(value: string, label: 'current' | 'previous'): Kek {
  const key = Buffer.from(value, 'base64');
  if (key.length !== KEY_LEN) {
    throw new KeyConfigurationError(
      `FILE_ENCRYPTION_KEY${label === 'previous' ? '_PREVIOUS' : ''} must be base64 for exactly ${KEY_LEN} bytes (got ${key.length})`,
    );
  }
  const idBytes = crypto.createHash('sha256').update('bbfk1').update(key).digest().subarray(0, 4);
  return { id: idBytes.toString('hex'), idBytes, key, label };
}

/**
 * Keys are resolved lazily so importing this module never throws at load time
 * in a tool that doesn't touch files. config.ts already fails fast on a
 * malformed key, so in practice this only runs once.
 */
let cachedKeks: { current: Kek; all: Kek[] } | null = null;

function keks(): { current: Kek; all: Kek[] } {
  if (cachedKeks) return cachedKeks;
  const current = decodeKek(config.files.encryptionKey, 'current');
  const all = [current];
  if (config.files.previousKey) {
    const previous = decodeKek(config.files.previousKey, 'previous');
    if (previous.id !== current.id) all.push(previous);
  }
  cachedKeks = { current, all };
  return cachedKeks;
}

/** Test seam: drop the cached keys after mutating config in a script/test. */
export function resetKeyCache(): void {
  cachedKeks = null;
}

/** Key id (hex) new writes are being sealed with — record this alongside the file. */
export function currentKeyVersion(): string {
  return keks().current.id;
}

/** Key id (hex) recorded in an encrypted file's header. */
export function keyVersionOf(enc: Buffer): string {
  requireHeader(enc);
  return enc.subarray(OFF_KEY_ID, OFF_KEY_ID + 4).toString('hex');
}

/** Ops helper: `node -e "import('./dist/lib/crypto.js').then(m=>console.log(m.generateKey()))"` */
export function generateKey(): string {
  return crypto.randomBytes(KEY_LEN).toString('base64');
}

/** True when the buffer starts with our magic bytes. Used to detect legacy plaintext. */
export function isEncrypted(buf: Buffer): boolean {
  return buf.length >= MAGIC.length && buf.subarray(0, MAGIC.length).equals(MAGIC);
}

/** Validate the fixed-size header prefix (magic + format version). */
function validateHeader(header: Buffer): void {
  if (header.length < HEADER_LEN) throw new DecryptionError('file is shorter than the envelope header');
  if (!isEncrypted(header)) throw new DecryptionError('bad magic bytes');
  if (header[OFF_VERSION] !== FORMAT_VERSION) {
    throw new DecryptionError(`unsupported format version ${header[OFF_VERSION]}`);
  }
}

/** Validate a whole envelope: header prefix plus room for the trailing tag. */
function requireHeader(enc: Buffer): void {
  if (enc.length < HEADER_LEN + TAG_LEN) throw new DecryptionError('file is shorter than the envelope');
  validateHeader(enc);
}

/** Build the 81-byte header and return it with the fresh DEK it wraps. */
function sealHeader(): { header: Buffer; dek: Buffer } {
  const { current } = keks();
  const dek = crypto.randomBytes(KEY_LEN);
  const header = Buffer.alloc(HEADER_LEN);

  MAGIC.copy(header, OFF_MAGIC);
  header[OFF_VERSION] = FORMAT_VERSION;
  current.idBytes.copy(header, OFF_KEY_ID);
  crypto.randomBytes(IV_LEN).copy(header, OFF_WRAP_IV);

  const wrap = crypto.createCipheriv('aes-256-gcm', current.key, header.subarray(OFF_WRAP_IV, OFF_WRAP_IV + IV_LEN));
  wrap.setAAD(header.subarray(0, WRAP_AAD_LEN));
  const wrapped = Buffer.concat([wrap.update(dek), wrap.final()]);
  wrap.getAuthTag().copy(header, OFF_WRAP_TAG);
  wrapped.copy(header, OFF_WRAPPED_DEK);

  crypto.randomBytes(IV_LEN).copy(header, OFF_DATA_IV);
  return { header, dek };
}

/** Recover the DEK from a header, trying the key id first then every configured KEK. */
function openHeader(header: Buffer): Buffer {
  validateHeader(header);
  const wantedId = header.subarray(OFF_KEY_ID, OFF_KEY_ID + 4).toString('hex');
  const { all } = keks();
  // Exact key-id match first; then any other configured key, so a file written
  // before an id-changing rotation still opens if the operator kept the key.
  const ordered = [...all.filter((k) => k.id === wantedId), ...all.filter((k) => k.id !== wantedId)];

  for (const kek of ordered) {
    try {
      const wrap = crypto.createDecipheriv(
        'aes-256-gcm',
        kek.key,
        header.subarray(OFF_WRAP_IV, OFF_WRAP_IV + IV_LEN),
      );
      wrap.setAAD(header.subarray(0, WRAP_AAD_LEN));
      wrap.setAuthTag(header.subarray(OFF_WRAP_TAG, OFF_WRAP_TAG + TAG_LEN));
      const dek = Buffer.concat([
        wrap.update(header.subarray(OFF_WRAPPED_DEK, OFF_WRAPPED_DEK + KEY_LEN)),
        wrap.final(),
      ]);
      if (dek.length === KEY_LEN) return dek;
    } catch {
      // Wrong KEK for this file — try the next one. Never surface which.
    }
  }
  throw new DecryptionError(`no configured key opens this file (key id ${wantedId})`);
}

// ---------------------------------------------------------------------------
// Buffered API
// ---------------------------------------------------------------------------

export function encryptBuffer(plain: Buffer): Buffer {
  const { header, dek } = sealHeader();
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, header.subarray(OFF_DATA_IV, OFF_DATA_IV + IV_LEN));
  cipher.setAAD(header);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  const out = Buffer.concat([header, body, cipher.getAuthTag()]);
  dek.fill(0);
  return out;
}

export function decryptBuffer(enc: Buffer): Buffer {
  requireHeader(enc);
  const header = enc.subarray(0, HEADER_LEN);
  const dek = openHeader(header);
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      dek,
      header.subarray(OFF_DATA_IV, OFF_DATA_IV + IV_LEN),
    );
    decipher.setAAD(header);
    decipher.setAuthTag(enc.subarray(enc.length - TAG_LEN));
    return Buffer.concat([decipher.update(enc.subarray(HEADER_LEN, enc.length - TAG_LEN)), decipher.final()]);
  } catch (err) {
    throw new DecryptionError(err instanceof Error ? err.message : 'authentication failed');
  } finally {
    dek.fill(0);
  }
}

// ---------------------------------------------------------------------------
// Streaming API
// ---------------------------------------------------------------------------

/**
 * Transform: plaintext in, envelope out. Emits the header before the first
 * ciphertext byte and the auth tag as the final 16 bytes.
 */
export function encryptStream(): Transform {
  const { header, dek } = sealHeader();
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, header.subarray(OFF_DATA_IV, OFF_DATA_IV + IV_LEN));
  cipher.setAAD(header);
  dek.fill(0);
  let headerWritten = false;

  const writeHeader = (push: (c: Buffer) => void) => {
    if (!headerWritten) {
      headerWritten = true;
      push(header);
    }
  };

  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      try {
        writeHeader((c) => this.push(c));
        const out = cipher.update(chunk);
        if (out.length) this.push(out);
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
    flush(cb) {
      try {
        writeHeader((c) => this.push(c)); // zero-byte payloads still get a valid envelope
        const out = cipher.final();
        if (out.length) this.push(out);
        this.push(cipher.getAuthTag());
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
  });
}

export interface DecryptStreamOptions {
  /**
   * When true (the default) a file that does NOT start with the magic bytes is
   * streamed through untouched. This is the compatibility path for documents
   * uploaded before encryption shipped; set false to hard-fail instead.
   */
  allowPlaintext?: boolean;
}

/**
 * Transform: envelope in, plaintext out. Sniffs the magic bytes, buffers the
 * 81-byte header, and holds back the trailing 16-byte tag so it can be handed
 * to `setAuthTag` at flush time.
 */
export function decryptStream(options: DecryptStreamOptions = {}): Transform {
  const allowPlaintext = options.allowPlaintext !== false;
  let mode: 'sniff' | 'enc' | 'plain' = 'sniff';
  let head: Buffer = Buffer.alloc(0);
  let tail: Buffer = Buffer.alloc(0);
  let decipher: crypto.DecipherGCM | null = null;

  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      try {
        let body: Buffer | null = null;

        if (mode === 'sniff') {
          head = head.length ? Buffer.concat([head, chunk]) : chunk;
          // Need 4 bytes to decide, then the full header to set up the cipher.
          if (head.length < MAGIC.length) return cb();
          if (!isEncrypted(head)) {
            if (!allowPlaintext) return cb(new DecryptionError('bad magic bytes'));
            mode = 'plain';
            this.push(head);
            head = Buffer.alloc(0);
            return cb();
          }
          if (head.length < HEADER_LEN) return cb();

          const header = head.subarray(0, HEADER_LEN);
          if (header[OFF_VERSION] !== FORMAT_VERSION) {
            return cb(new DecryptionError(`unsupported format version ${header[OFF_VERSION]}`));
          }
          const dek = openHeader(header);
          decipher = crypto.createDecipheriv(
            'aes-256-gcm',
            dek,
            header.subarray(OFF_DATA_IV, OFF_DATA_IV + IV_LEN),
          ) as crypto.DecipherGCM;
          decipher.setAAD(header);
          dek.fill(0);
          mode = 'enc';
          body = head.subarray(HEADER_LEN);
          head = Buffer.alloc(0);
        } else if (mode === 'plain') {
          this.push(chunk);
          return cb();
        } else {
          body = chunk;
        }

        // Keep the last TAG_LEN bytes back — they are the auth tag, not payload.
        const all = tail.length ? Buffer.concat([tail, body]) : body;
        if (all.length > TAG_LEN) {
          const cut = all.length - TAG_LEN;
          const out = decipher!.update(all.subarray(0, cut));
          if (out.length) this.push(out);
          tail = Buffer.from(all.subarray(cut));
        } else {
          tail = Buffer.from(all);
        }
        cb();
      } catch (err) {
        cb(err instanceof DecryptionError ? err : new DecryptionError((err as Error).message));
      }
    },
    flush(cb) {
      try {
        if (mode === 'plain') return cb();
        if (mode === 'sniff') {
          // Ended before we could decide: a short plaintext file, or a truncated one.
          if (head.length && isEncrypted(head)) {
            return cb(new DecryptionError('file ends inside the envelope header'));
          }
          if (head.length && !allowPlaintext) return cb(new DecryptionError('bad magic bytes'));
          if (head.length) this.push(head);
          return cb();
        }
        if (tail.length !== TAG_LEN) return cb(new DecryptionError('truncated file: auth tag missing'));
        decipher!.setAuthTag(tail);
        const out = decipher!.final();
        if (out.length) this.push(out);
        cb();
      } catch (err) {
        cb(new DecryptionError(err instanceof Error ? err.message : 'authentication failed'));
      }
    },
  });
}
