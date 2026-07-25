/**
 * Binds a browser account to a SuperSync account (anex/container-parity).
 *
 * Each browser user owns one SuperSync account, and therefore one op-log. The
 * sync server was already multi-tenant — every op carries a userId and each
 * user has an independent serverSeq — so isolation costs nothing there. What
 * was missing is the mapping: the container knew exactly one account, the one
 * from SP_SYNC_ACCOUNT_EMAIL.
 *
 * ## Passwords nobody types
 * Sync accounts need a password, but no human ever authenticates with one — the
 * browser holds a token and the bridge speaks the internal channel. So they are
 * derived, `HMAC(JWT_SECRET, "sync-account:" + email)`, and never stored. The
 * secret already gates the provisioning route, so this adds no new material to
 * protect, and there is nothing to reset or leak.
 *
 * ## The first user keeps their board
 * A stack upgraded from single-user has one account whose data lives under
 * SP_SYNC_ACCOUNT_EMAIL. That user is bound to that address rather than given a
 * fresh one, otherwise the upgrade would silently present them an empty board
 * while their tasks sat in an account nothing pointed at any more.
 */
import { createHmac } from 'node:crypto';
import type { BridgeConfig } from '../config';
import type { AuthStore, UserRow } from './store';
import { WebappTokenProvider, WEBAPP_TOKEN_SETTING_KEY } from '../webapp-token';

/** One stored token per board, for the cursor-stability reason in webapp-token.ts. */
const tokenSettingKey = (userId: number): string => `supersync.user_token.${userId}`;

export const deriveSyncPassword = (jwtSecret: string, address: string): string =>
  createHmac('sha256', jwtSecret).update(`sync-account:${address}`).digest('base64url');

/**
 * The address a user's board lives under, derived from their immutable bridge
 * id. `.invalid` is reserved by RFC 2606, so it can never collide with a real
 * inbox.
 *
 * Deliberately NOT their email. Email is editable profile data, and an editable
 * identity means editing it either does nothing or silently moves the user to a
 * different, empty board. The id cannot change, so neither can the board.
 */
export const syncAddressFor = (bridgeUserId: number): string =>
  `sp-user-${bridgeUserId}@sp.invalid`;

interface ProvisionResult {
  token: string;
  userId: number;
  email: string;
}

const provision = async (
  cfg: BridgeConfig,
  email: string,
  password: string,
): Promise<ProvisionResult> => {
  const res = await fetch(`${cfg.syncServerUrl}/api/internal/provision`, {
    method: 'POST',
    headers: {
      'X-Internal-Secret': cfg.jwtSecret,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `sp-bridge: provisioning ${email} failed (${res.status}) ${body.slice(0, 200)}`,
    );
  }
  return (await res.json()) as ProvisionResult;
};

/**
 * Removes a SuperSync account and, by cascade, every op/device/sync-state row
 * it owns. The sync server refuses to delete the container's own account.
 */
export const purgeSyncAccount = async (
  cfg: BridgeConfig,
  supersyncUserId: number,
): Promise<void> => {
  const res = await fetch(`${cfg.syncServerUrl}/api/internal/users/${supersyncUserId}`, {
    method: 'DELETE',
    headers: { 'X-Internal-Secret': cfg.jwtSecret },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`sync server returned ${res.status} ${body.slice(0, 200)}`);
  }
};

export class SyncIdentityProvider {
  private readonly _tokens = new Map<number, WebappTokenProvider>();

  constructor(
    private readonly _store: AuthStore,
    private readonly _cfg: BridgeConfig,
  ) {}

  /**
   * The address a user's board lives under.
   *
   * The first user gets the container account, so a stack upgraded from
   * single-user keeps the data it already had — otherwise the upgrade would
   * present an empty board while their tasks sat in an account nothing pointed
   * at. Everyone else gets an address derived from their immutable id.
   *
   * `email` is never consulted: it is profile data, and identity that a user
   * can edit is identity that can move their board out from under them.
   */
  private async _addressFor(user: UserRow): Promise<string> {
    const isFirstUser = (await this._store.listUsers())[0]?.id === user.id;
    if (isFirstUser && this._cfg.syncAccountEmail) {
      return this._cfg.syncAccountEmail;
    }
    return syncAddressFor(user.id);
  }

  /**
   * Access token for the board this user owns, provisioning the account the
   * first time. Persisted per user, so the token a browser holds survives
   * restarts — a rotating one puts the "Server Already Contains Data" prompt
   * back in front of them.
   */
  async tokenForUser(user: UserRow): Promise<string> {
    const existing = this._tokens.get(user.id);
    if (existing) return existing.get();

    const address = await this._addressFor(user);
    const isContainerAccount = Boolean(
      this._cfg.syncAccountEmail && address === this._cfg.syncAccountEmail,
    );
    // The container account keeps its configured password: the sync server
    // rewrites that hash from env on every boot, so deriving one here would be
    // overwritten at the next restart.
    const password =
      isContainerAccount && this._cfg.syncAccountPassword
        ? this._cfg.syncAccountPassword
        : deriveSyncPassword(this._cfg.jwtSecret, address);

    // Whoever owns the container account reuses the token single-user
    // deployments already served. A per-user key would store a DIFFERENT token
    // for the same account, and since the cursor is keyed on
    // hash(baseUrl|accessToken), every existing browser would silently reset to
    // seq 0 and re-download the whole op-log on upgrade.
    const provider = new WebappTokenProvider(
      this._store,
      async () => {
        const result = await provision(this._cfg, address, password);
        await this._store.setSyncUserId(user.id, result.userId);
        return result.token;
      },
      isContainerAccount ? WEBAPP_TOKEN_SETTING_KEY : tokenSettingKey(user.id),
    );
    this._tokens.set(user.id, provider);
    return provider.get();
  }
}
