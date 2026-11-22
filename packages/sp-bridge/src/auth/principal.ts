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
 * Which board a request is addressing.
 *
 * `explicit` records that the caller asked by name rather than inheriting a browser's stored choice. The two want different answers when the board
 * turns out to be unreadable: a stale cookie should quietly fall back to your own board, an instruction should be told it failed.
 */
export type BoardTarget =
  | { kind: 'own' }
  | { kind: 'other'; id: number; explicit: boolean }
  | { kind: 'invalid'; raw: string };

/**
 * The board a request means, from the `boardOf` query parameter or, failing that, the board a browser session is currently viewing.
 *
 * An explicit parameter beats the session: a request that names a board means it. Naming your own id is not "somebody else's board", so a script can
 * pass `boardOf` unconditionally without tripping the permission check.
 */
export const boardTargetFor = (
  boardOf: readonly string[],
  sessionViewingUserId: number | null | undefined,
  callerId: number,
): BoardTarget => {
  if (boardOf.length > 1) return { kind: 'invalid', raw: boardOf.join(',') };
  const raw = boardOf[0];
  if (raw !== undefined && raw !== '') {
    if (!/^\d+$/.test(raw)) return { kind: 'invalid', raw };
    const id = Number(raw);
    return id === callerId ? { kind: 'own' } : { kind: 'other', id, explicit: true };
  }
  if (sessionViewingUserId && sessionViewingUserId !== callerId) {
    return { kind: 'other', id: sessionViewingUserId, explicit: false };
  }
  return { kind: 'own' };
};

export const IMPORT_PATH = '/api/import';

/** The one write allowed on another account's board: an admin replacing it with an import. `route` is the matched route's pattern. */
export const mayWriteOtherBoard = (
  method: string,
  route: string,
  role: string,
): boolean =>
  role === 'admin' && method.toUpperCase() === 'POST' && route === IMPORT_PATH;

/** Where a key-driven call carries the caller's password: a header on the import route, whose body is the file itself. */
export const callerPasswordFrom = (
  route: string,
  headers: Record<string, string | string[] | undefined>,
  body: unknown,
): unknown => {
  if (route === IMPORT_PATH) return headers['x-current-password'];
  return (body as { currentPassword?: unknown } | undefined)?.currentPassword;
};

const PASSWORD_ROUTES = new Set([
  'POST /api/auth/users/:id/keys',
  'DELETE /api/auth/users/:id/keys/:keyId',
  'POST /api/auth/users/:id/keys/:keyId/revoke',
  'PUT /api/auth/users/:id/public',
  `POST ${IMPORT_PATH}`,
]);

/**
 * Calls that hand out or widen access, or replace a whole board, and so need the caller's password when driven by an API key.
 * `route` is the matched route's pattern, never the request URL, which can spell the same route another way.
 *
 * Reading someone's keys is deliberately absent: an admin holding a subordinate's key is how delegated management works in this fork,
 * so gating it would put friction on the normal path rather than on the dangerous one.
 */
export const needsCallerPassword = (
  method: string,
  route: string,
  body: unknown,
): boolean => {
  const m = method.toUpperCase();
  if (PASSWORD_ROUTES.has(`${m} ${route}`)) return true;
  // Only when the role is actually changing: renaming somebody, or fixing their email, widens nothing.
  if (m === 'PUT' && route === '/api/auth/users/:id') {
    return typeof body === 'object' && body !== null && 'role' in body;
  }
  return false;
};
