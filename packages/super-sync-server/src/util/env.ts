import { Logger } from '../logger';

const POSITIVE_INTEGER_PATTERN = /^\d+$/;

/**
 * Parse a positive-integer env var with strict validation and an optional
 * upper bound. Trailing garbage ("5000abc"), separators ("5,000"), floats,
 * or negative values are rejected and the caller's `fallback` is used.
 *
 * `maxValue`, when set, clamps the parsed value — this is the difference
 * between "operator misconfigured the knob" (warn + fallback) and "operator
 * picked an unreasonably large value" (warn + clamp).
 */
export const parsePositiveIntegerEnv = (
  name: string,
  fallback: number,
  maxValue?: number,
): number => {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue === '') return fallback;

  if (!POSITIVE_INTEGER_PATTERN.test(rawValue)) {
    Logger.warn(`Invalid ${name}="${rawValue}". Falling back to ${fallback}.`);
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    Logger.warn(`Invalid ${name}="${rawValue}". Falling back to ${fallback}.`);
    return fallback;
  }

  if (maxValue !== undefined && parsed > maxValue) {
    Logger.warn(
      `${name}=${parsed} exceeds maximum ${maxValue}. Clamping to ${maxValue}.`,
    );
    return maxValue;
  }

  return parsed;
};

const SIZE_PATTERN = /^(\d+(?:\.\d+)?)\s*(k|kb|m|mb|g|gb|t|tb)$/i;
const SIZE_UNIT_BYTES: Record<string, number> = {
  k: 1024,
  m: 1024 ** 2,
  g: 1024 ** 3,
  t: 1024 ** 4,
};

/**
 * anex/self-hosted: a human size such as `256m`, `1g` or `256MB` in bytes, or null when it is not one.
 * Units count in 1024s, as Docker's memory limits in the same .env do. A bare number is refused, not guessed:
 * `256` could mean bytes or megabytes, and guessing wrong would set a quota a million times off.
 */
export const parseSizeToBytes = (raw: string): number | null => {
  const match = SIZE_PATTERN.exec(raw.trim());
  if (!match) return null;
  const bytes = Math.floor(Number(match[1]) * SIZE_UNIT_BYTES[match[2][0].toLowerCase()]);
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
};

/**
 * anex/self-hosted: the per-account sync storage limit set in .env, in bytes, or 0 when none is set.
 * SYNC_STORAGE_LIMIT (`256m`, `1g`) wins; STORAGE_QUOTA_BYTES is the older spelling in plain bytes and still works.
 * Throws on an unreadable SYNC_STORAGE_LIMIT; loadConfigFromEnv calls this, so a typo stops the server at start
 * instead of silently leaving every account on the 100 MB default.
 */
export const storageLimitFromEnv = (): number => {
  const limit = process.env.SYNC_STORAGE_LIMIT?.trim();
  if (limit) {
    const bytes = parseSizeToBytes(limit);
    if (bytes === null) {
      throw new Error(
        `Invalid SYNC_STORAGE_LIMIT="${limit}": use a size with a unit, e.g. 256m or 1g.`,
      );
    }
    return bytes;
  }
  return parsePositiveIntegerEnv('STORAGE_QUOTA_BYTES', 0);
};
