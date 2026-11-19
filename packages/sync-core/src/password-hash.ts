/**
 * Argon2id for stored password hashes (anex/argon2id-passwords).
 *
 * The raw derivation only: a server stores and checks account passwords with the same Argon2id implementation sync-core
 * already ships for encryption keys, so it needs no password-hashing package of its own. Formatting the stored string and
 * the constant-time comparison stay with the caller, which knows its storage format.
 */
import { argon2id } from 'hash-wasm';

export interface Argon2idPasswordParams {
  /** Memory cost in KiB (OWASP: 19456 = 19 MiB with 2 iterations). */
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  hashLength: number;
}

export const deriveArgon2idPasswordHash = (
  password: string,
  salt: Uint8Array,
  params: Argon2idPasswordParams,
): Promise<Uint8Array> =>
  argon2id({
    password,
    salt,
    memorySize: params.memoryKiB,
    iterations: params.iterations,
    parallelism: params.parallelism,
    hashLength: params.hashLength,
    outputType: 'binary',
  });
