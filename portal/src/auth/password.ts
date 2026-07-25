import { hash, verify, Algorithm } from '@node-rs/argon2';

/**
 * argon2id parameters per spec (and OWASP baseline):
 * memory 19 MiB, iterations 2, parallelism 1.
 */
const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19 * 1024, // KiB
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_OPTIONS);
}

export async function verifyPassword(hashStr: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashStr, plain);
  } catch {
    // Malformed hash etc. — treat as failed verification, never throw to caller.
    return false;
  }
}

/**
 * A real argon2id hash of a throwaway password. Verified against when the
 * email doesn't match a user so login timing doesn't reveal account existence.
 */
export const DUMMY_HASH_PROMISE: Promise<string> = hashPassword('dummy-password-for-timing');
