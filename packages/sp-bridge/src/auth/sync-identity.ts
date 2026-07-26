/**
 * Binds a browser account to a SuperSync account (anex/container-parity).
 *
 * Each browser user owns one SuperSync account, and therefore one op-log. The
 * sync server was already multi-tenant - every op carries a userId and each
 * user has an independent serverSeq - so isolation costs nothing there. What
 * was missing is the mapping: the container knew exactly one account, the one
 * from SP_SYNC_ACCOUNT_EMAIL.
 *
 * ## Passwords nobody types
 * Sync accounts need a password, but no human ever authenticates with one - the
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

/**
 * The read-only token for a published board, keyed on its OWNER rather than on whoever is reading.
 * One token per board, shared by every viewer of it, for the same cursor-stability reason: the client keys its sync cursor on hash(baseUrl|accessToken), so a
 * per-viewer token would make each reader re-download the whole op-log and would reset them again on every restart.
 */
const readTokenSettingKey = (ownerId: number): string =>
  `supersync.board_read_token.${ownerId}`;

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
  scope?: 'read',
): Promise<ProvisionResult> => {
  const res = await fetch(`${cfg.syncServerUrl}/api/internal/provision`, {
    method: 'POST',
    headers: {
      'X-Internal-Secret': cfg.jwtSecret,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password, ...(scope ? { scope } : {}) }),
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

/**
 * Whether a user's own board holds anything yet.
 *
 * The bridge syncs ONE account, so its own sequence number answers this for the
 * container account and nobody else - reporting that to a new user made the
 * replica gate adopt a stale replica instead of purging it.
 *
 * Unreachable sync server resolves to `true`: the gate treats that as "has
 * data" and takes the non-destructive branch, so a blip cannot delete a board.
 */
export const boardHasData = async (
  cfg: BridgeConfig,
  supersyncUserId: number | null,
): Promise<boolean> => {
  if (!supersyncUserId) {
    // No id of its own. The container account is the case that matters: it
    // binds by email and never gets one, so answering "empty" here told its
    // owner's browser the server was blank and the replica gate purged a board
    // holding everything. Only a genuinely unprovisioned account is empty, and
    // the caller distinguishes the two.
    return true;
  }
  try {
    const res = await fetch(
      `${cfg.syncServerUrl}/api/internal/users/${supersyncUserId}/has-data`,
      { headers: { 'X-Internal-Secret': cfg.jwtSecret } },
    );
    if (!res.ok) return true;
    const body = (await res.json()) as { hasData?: unknown };
    return body.hasData !== false;
  } catch {
    return true;
  }
};

export class SyncIdentityProvider {
  private readonly _tokens = new Map<number, WebappTokenProvider>();
  private readonly _readTokens = new Map<number, WebappTokenProvider>();

  constructor(
    private readonly _store: AuthStore,
    private readonly _cfg: BridgeConfig,
  ) {}

  /**
   * The address a user's board lives under.
   *
   * The first user gets the container account, so a stack upgraded from
   * single-user keeps the data it already had - otherwise the upgrade would
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
   * restarts - a rotating one puts the "Server Already Contains Data" prompt
   * back in front of them.
   */
  /**
   * Whether this user IS the container account, and so shares the board the
   * bridge already syncs. UserBoards needs this to avoid opening a second store
   * against the same account.
   */
  async isContainerAccount(user: UserRow): Promise<boolean> {
    const address = await this._addressFor(user);
    return Boolean(this._cfg.syncAccountEmail && address === this._cfg.syncAccountEmail);
  }

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

  /**
   * A read-only token for `owner`'s board, to hand to somebody who is not the owner.
   *
   * This is the credential that makes publishing safe. It names the owner's sync account, because that is whose op-log the reader must download, but carries
   * `scope: 'read'`, which the sync server refuses on every route that changes data. Without the scope this would be an unrestricted write credential for
   * someone else's board: the sync API is on the same public origin as the app and authenticates by token alone, so the bridge's own role check never sees it.
   *
   * Refuses an owner with no sync account. There is no board to read yet, and provisioning one here would create an empty account as a side effect of
   * somebody trying to view it.
   */
  async tokenForBoardRead(owner: UserRow): Promise<string> {
    if (!owner.supersyncUserId) {
      throw new Error(`No board to read: user ${owner.id} has no sync account yet`);
    }
    const existing = this._readTokens.get(owner.id);
    if (existing) return existing.get();

    const address = await this._addressFor(owner);
    const isContainerAccount = Boolean(
      this._cfg.syncAccountEmail && address === this._cfg.syncAccountEmail,
    );
    const password =
      isContainerAccount && this._cfg.syncAccountPassword
        ? this._cfg.syncAccountPassword
        : deriveSyncPassword(this._cfg.jwtSecret, address);

    const provider = new WebappTokenProvider(
      this._store,
      async () => (await provision(this._cfg, address, password, 'read')).token,
      readTokenSettingKey(owner.id),
    );
    this._readTokens.set(owner.id, provider);
    return provider.get();
  }

  /**
   * Drops any cached read token for a board.
   * Called when a board is unpublished so the next viewer mints afresh rather than being served from a map that outlived the permission.
   */
  forgetBoardReadToken(ownerId: number): void {
    this._readTokens.delete(ownerId);
  }
}
