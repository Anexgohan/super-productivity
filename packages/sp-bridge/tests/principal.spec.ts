import { describe, expect, it } from 'vitest';
import { needsCallerPassword } from '../src/auth/principal';

/**
 * The rule that keeps "revoke the leaked key" a complete answer: a key alone must not be able to hand out or widen access.
 * These are the calls that do, and everything else must stay free of the extra round trip.
 */
describe('needsCallerPassword', () => {
  it('gates minting a key', () => {
    expect(needsCallerPassword('POST', '/api/auth/users/1/keys', {})).toBe(true);
  });

  it('gates revoking and deleting a key', () => {
    expect(needsCallerPassword('POST', '/api/auth/users/1/keys/4/revoke', {})).toBe(true);
    expect(needsCallerPassword('DELETE', '/api/auth/users/1/keys/4', undefined)).toBe(
      true,
    );
  });

  it('gates publishing a board', () => {
    expect(
      needsCallerPassword('PUT', '/api/auth/users/2/public', { isPublic: true }),
    ).toBe(true);
  });

  it('gates a role change but not a rename or an email edit on the same route', () => {
    expect(needsCallerPassword('PUT', '/api/auth/users/2', { role: 'admin' })).toBe(true);
    expect(needsCallerPassword('PUT', '/api/auth/users/2', { username: 'sam' })).toBe(
      false,
    );
    expect(needsCallerPassword('PUT', '/api/auth/users/2', { email: 'a@b.c' })).toBe(
      false,
    );
  });

  it('leaves reading keys free, which is how delegated management works here', () => {
    expect(needsCallerPassword('GET', '/api/auth/users/1/keys', undefined)).toBe(false);
  });

  it('leaves ordinary board and account traffic free', () => {
    expect(needsCallerPassword('POST', '/api/tasks', { title: 'x' })).toBe(false);
    expect(needsCallerPassword('GET', '/api/auth/me', undefined)).toBe(false);
    expect(needsCallerPassword('PUT', '/api/auth/password', { newPassword: 'x' })).toBe(
      false,
    );
    expect(needsCallerPassword('DELETE', '/api/auth/users/2', undefined)).toBe(false);
  });

  it('ignores the query string and is case-insensitive on the method', () => {
    expect(needsCallerPassword('post', '/api/auth/users/1/keys?label=ci', {})).toBe(true);
  });

  it('does not match a path that merely looks similar', () => {
    expect(needsCallerPassword('POST', '/api/auth/users/abc/keys', {})).toBe(false);
    expect(needsCallerPassword('POST', '/api/auth/users/1/keys/extra', {})).toBe(false);
  });
});
