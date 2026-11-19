import { describe, expect, it } from 'vitest';
import { parseSizeToBytes } from '../src/util/env';

describe('parseSizeToBytes', () => {
  it('reads sizes the way the memory limits in .env are written, in 1024s', () => {
    expect(parseSizeToBytes('256m')).toBe(268435456);
    expect(parseSizeToBytes('256MB')).toBe(268435456);
    expect(parseSizeToBytes('1g')).toBe(1073741824);
    expect(parseSizeToBytes(' 1.5 GB ')).toBe(1610612736);
    expect(parseSizeToBytes('512k')).toBe(524288);
  });

  it('refuses a bare number, a zero or anything else rather than guessing', () => {
    for (const raw of ['256', '0m', 'm', 'lots', '256 megabytes', '-1g', '']) {
      expect(parseSizeToBytes(raw)).toBeNull();
    }
  });
});
