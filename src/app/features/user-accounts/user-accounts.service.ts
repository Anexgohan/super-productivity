/**
 * Talks to sp-bridge's /api/auth/* routes (anex/container-parity).
 *
 * Deliberately plain `fetch` against same-origin paths rather than anything
 * routed through `GlobalConfig`. Accounts and roles are access control, and
 * `GlobalConfig` is synced op-log data - encrypted, per-user, and unreadable by
 * the server, so it is the one place access control cannot live. The session
 * cookie rides along with a same-origin request automatically.
 */
import { Injectable } from '@angular/core';

export type Role = 'admin' | 'operator' | 'viewer';

export interface UserRow {
  id: number;
  username: string;
  role: Role;
  email: string | null;
  isPublic: boolean;
}

/** Everything the admin edit dialog can change in one go. */
export interface UserChanges {
  username?: string;
  role?: Role;
  password?: string;
  email?: string | null;
}

export interface CurrentUser {
  id: number;
  username: string;
  role: Role;
  email?: string | null;
  /** Whether this account's own board is shared read-only with everyone signed in. */
  isPublic?: boolean;
  /** Whose shared board this browser is reading, or null for your own. */
  viewingUserId?: number | null;
}

/**
 * An API key as the server describes it. `key` is re-derived per request rather than stored, so it can be shown again whenever its owner asks.
 * Null once revoked, because a revoked key no longer authenticates anything.
 */
export interface ApiKeyRow {
  id: number;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  key: string | null;
}

const json = async <T>(res: Response): Promise<T> => {
  if (!res.ok) {
    // The bridge answers with { error } on every failure path; fall back to the
    // status only when something else (a proxy, say) answered instead.
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
};

const send = <T>(url: string, method: string, body?: unknown): Promise<T> => {
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  return fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((res) => json<T>(res));
};

@Injectable({ providedIn: 'root' })
export class UserAccountsService {
  me(): Promise<CurrentUser> {
    return send<CurrentUser>('/api/auth/me', 'GET');
  }

  updateOwnEmail(email: string | null): Promise<UserRow> {
    return send<UserRow>('/api/auth/me', 'PUT', { email });
  }

  changeOwnPassword(currentPassword: string, newPassword: string): Promise<void> {
    return send('/api/auth/password', 'PUT', { currentPassword, newPassword });
  }

  logout(): Promise<void> {
    return send('/api/auth/logout', 'POST');
  }

  // ── Admin only ────────────────────────────────────────────────────────────
  listUsers(): Promise<UserRow[]> {
    return send<UserRow[]>('/api/auth/users', 'GET');
  }

  createUser(input: {
    username: string;
    password: string;
    role: Role;
    email?: string | null;
  }): Promise<UserRow> {
    return send<UserRow>('/api/auth/users', 'POST', input);
  }

  updateUser(id: number, changes: UserChanges): Promise<UserRow> {
    return send<UserRow>(`/api/auth/users/${id}`, 'PUT', changes);
  }

  /** Full id list, in display order - the server rejects a partial one. */
  setOrder(ids: number[]): Promise<void> {
    return send('/api/auth/users/order', 'PUT', { ids });
  }

  /** Irreversible: removes the login AND the account's synced data. */
  deleteUser(id: number): Promise<void> {
    return send(`/api/auth/users/${id}`, 'DELETE');
  }

  // ── API keys: own, or anyone's when the caller is an admin ────────────────
  listApiKeys(userId: number): Promise<{ keys: ApiKeyRow[] }> {
    return send<{ keys: ApiKeyRow[] }>(`/api/auth/users/${userId}/keys`, 'GET');
  }

  createApiKey(userId: number, label: string): Promise<ApiKeyRow> {
    return send<ApiKeyRow>(`/api/auth/users/${userId}/keys`, 'POST', { label });
  }

  /** Kills the key but keeps the row, so the list still shows it existed. */
  revokeApiKey(userId: number, keyId: number): Promise<{ revoked: boolean }> {
    return send<{ revoked: boolean }>(
      `/api/auth/users/${userId}/keys/${keyId}/revoke`,
      'POST',
    );
  }

  /** Removes the record as well. Only offered for keys already revoked. */
  deleteApiKey(userId: number, keyId: number): Promise<{ deleted: boolean }> {
    return send<{ deleted: boolean }>(
      `/api/auth/users/${userId}/keys/${keyId}`,
      'DELETE',
    );
  }

  // ── Publishing: own board, or anyone's when the caller is an admin ─────────
  /**
   * Shares a board read-only. Whole-board by necessity: the server holds encrypted ops it cannot read, so it has no way to share only part of one.
   */
  setPublic(
    userId: number,
    isPublic: boolean,
  ): Promise<{ id: number; isPublic: boolean }> {
    return send<{ id: number; isPublic: boolean }>(
      `/api/auth/users/${userId}/public`,
      'PUT',
      { isPublic },
    );
  }

  /** Boards shared with this account, and which one it is currently reading. */
  publicBoards(): Promise<{
    viewing: number | null;
    boards: { id: number; username: string }[];
  }> {
    return send('/api/auth/public-boards', 'GET');
  }

  /**
   * Opens somebody else's shared board, or `null` to go back to your own.
   * The browser reloads afterwards: sync credentials are read at startup, so the app boots against the new board rather than swapping it mid-flight.
   */
  setViewing(userId: number | null): Promise<unknown> {
    return send('/api/auth/viewing', 'POST', { userId });
  }

  getRegistration(): Promise<{ isEnabled: boolean }> {
    return send<{ isEnabled: boolean }>('/api/auth/registration', 'GET');
  }

  setRegistration(isEnabled: boolean): Promise<{ isEnabled: boolean }> {
    return send<{ isEnabled: boolean }>('/api/auth/registration', 'PUT', { isEnabled });
  }
}
