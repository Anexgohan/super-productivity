/**
 * Who a request is, and the one rule that cares how they proved it.
 *
 * Kept apart from rest.ts and routes.ts because both need it: rest.ts resolves the principal in its auth hook, routes.ts acts on it.
 * Pure, so the rule below is unit-testable - the routes it guards need a live Postgres to exercise.
 */
import type { UserRow } from './store';

/**
 * Both credentials name the same user and carry the same role.
 * `viaKey` matters only where a credential could be used to widen access: a stolen key must not be able to mint another one.
 */
export interface Principal {
  user: UserRow;
  viaKey: boolean;
}

/**
 * Calls that hand out or widen access, and so need the caller's password when driven by an API key.
 *
 * Reading someone's keys is deliberately absent: an admin holding a subordinate's key is how delegated management works in this fork,
 * so gating it would put friction on the normal path rather than on the dangerous one.
 */
export const needsCallerPassword = (
  method: string,
  url: string,
  body: unknown,
): boolean => {
  const path = url.split('?')[0];
  const m = method.toUpperCase();
  if (/^\/api\/auth\/users\/\d+\/keys$/.test(path) && m === 'POST') return true;
  if (/^\/api\/auth\/users\/\d+\/keys\/\d+$/.test(path) && m === 'DELETE') return true;
  if (/^\/api\/auth\/users\/\d+\/keys\/\d+\/revoke$/.test(path) && m === 'POST')
    return true;
  if (/^\/api\/auth\/users\/\d+\/public$/.test(path) && m === 'PUT') return true;
  // Only when the role is actually changing: renaming somebody, or fixing their email, widens nothing.
  if (/^\/api\/auth\/users\/\d+$/.test(path) && m === 'PUT') {
    return typeof body === 'object' && body !== null && 'role' in body;
  }
  return false;
};
