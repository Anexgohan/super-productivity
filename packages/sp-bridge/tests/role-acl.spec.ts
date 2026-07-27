import { describe, expect, it } from 'vitest';
import { isRole, ROLE_LEVELS, ROLES } from '../src/auth/store';
import { canWrite, isReadOnlyRequest } from '../src/rest';

describe('roles', () => {
  it('orders privilege admin > operator > viewer', () => {
    expect(ROLE_LEVELS.admin).toBeGreaterThan(ROLE_LEVELS.operator);
    expect(ROLE_LEVELS.operator).toBeGreaterThan(ROLE_LEVELS.viewer);
  });

  it('gives every declared role a level', () => {
    // A role in ROLES but missing from ROLE_LEVELS would make canWrite return undefined-ish and fail open.
    for (const role of ROLES) expect(typeof ROLE_LEVELS[role]).toBe('number');
  });

  it('accepts exactly the declared roles', () => {
    for (const role of ROLES) expect(isRole(role)).toBe(true);
  });

  it('rejects anything else, including casing variants', () => {
    for (const bad of [
      'Admin',
      'ADMIN',
      'root',
      'superuser',
      '',
      ' admin',
      undefined,
      null,
      3,
    ]) {
      expect(isRole(bad)).toBe(false);
    }
  });
});

describe('canWrite', () => {
  it('lets admin and operator write', () => {
    expect(canWrite('admin')).toBe(true);
    expect(canWrite('operator')).toBe(true);
  });

  it('refuses a viewer', () => {
    // This is the whole read-only guarantee: a shared board must not be writable by whoever is viewing it.
    expect(canWrite('viewer')).toBe(false);
  });

  it('refuses an unknown role rather than failing open', () => {
    for (const bad of ['', 'Admin', 'root', 'superuser', 'owner']) {
      expect(canWrite(bad)).toBe(false);
    }
  });
});

describe('isReadOnlyRequest', () => {
  it('treats GET, HEAD and OPTIONS as read-only', () => {
    for (const m of ['GET', 'HEAD', 'OPTIONS']) expect(isReadOnlyRequest(m)).toBe(true);
  });

  it('is case-insensitive, since the method arrives off the wire', () => {
    for (const m of ['get', 'Get', 'head', 'options']) {
      expect(isReadOnlyRequest(m)).toBe(true);
    }
  });

  it('treats every mutating method as a write', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'patch']) {
      expect(isReadOnlyRequest(m)).toBe(false);
    }
  });

  it('treats an unrecognised method as a write', () => {
    // Failing closed matters more than being correct about TRACE.
    for (const m of ['TRACE', 'CONNECT', 'PROPFIND', '']) {
      expect(isReadOnlyRequest(m)).toBe(false);
    }
  });
});

describe('the viewer contract', () => {
  it('permits reads and refuses writes for a viewer across every method', () => {
    // Mirrors the gate in createRestServer: a request is refused when it mutates and the role cannot write.
    const refused = (method: string, role: string): boolean =>
      !isReadOnlyRequest(method) && !canWrite(role);

    expect(refused('GET', 'viewer')).toBe(false);
    expect(refused('HEAD', 'viewer')).toBe(false);
    expect(refused('POST', 'viewer')).toBe(true);
    expect(refused('PATCH', 'viewer')).toBe(true);
    expect(refused('DELETE', 'viewer')).toBe(true);
    expect(refused('POST', 'operator')).toBe(false);
    expect(refused('DELETE', 'admin')).toBe(false);
  });
});
