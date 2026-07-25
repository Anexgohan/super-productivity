/**
 * Talks to sp-bridge's /api/auth/* routes (anex/container-parity).
 *
 * Deliberately plain `fetch` against same-origin paths rather than anything
 * routed through `GlobalConfig`. Accounts and roles are access control, and
 * `GlobalConfig` is synced op-log data — encrypted, per-user, and unreadable by
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
  username: string;
  role: Role;
  email?: string | null;
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

  /** Full id list, in display order — the server rejects a partial one. */
  setOrder(ids: number[]): Promise<void> {
    return send('/api/auth/users/order', 'PUT', { ids });
  }

  /** Irreversible: removes the login AND the account's synced data. */
  deleteUser(id: number): Promise<void> {
    return send(`/api/auth/users/${id}`, 'DELETE');
  }

  getRegistration(): Promise<{ isEnabled: boolean }> {
    return send<{ isEnabled: boolean }>('/api/auth/registration', 'GET');
  }

  setRegistration(isEnabled: boolean): Promise<{ isEnabled: boolean }> {
    return send<{ isEnabled: boolean }>('/api/auth/registration', 'PUT', { isEnabled });
  }
}
