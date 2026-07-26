/**
 * Stable SuperSync access token for served browsers (anex/container-parity).
 *
 * ## Why this exists
 * SuperSync derives the localStorage key it tracks `lastServerSeq` under from
 * `hash(baseUrl | accessToken)` (see `_getServerSeqKey` in the sync-providers
 * package). That is correct upstream - it separates two users sharing one
 * server - but it assumes the token is a stable identity.
 *
 * The container's entrypoint used to mint a fresh JWT on every start, so the
 * hash changed on every restart, `getLastServerSeq()` fell back to 0, and each
 * browser concluded it had never met this server. With data on both sides that
 * lands on ServerMigrationService's "Server Already Contains Data" prompt - a
 * one-click path to overwriting the server, shown for no real reason.
 *
 * So the token is minted ONCE and persisted here. Restarts hand back the same
 * string, browsers keep their cursor, and the prompt stays where it belongs.
 *
 * ## Why in the bridge rather than the entrypoint
 * The entrypoint is a shell script in a stateless container; the bridge already
 * owns durable state in Postgres and the internal-secret channel to the sync
 * server. Fixing it here also keeps `packages/sync-providers/` untouched -
 * keying the cursor on a `userId` claim would work too, but that is upstream
 * code we would re-merge forever, and the rotation is our container's doing.
 */
import type { AuthStore } from './auth/store';

export const WEBAPP_TOKEN_SETTING_KEY = 'supersync.webapp_access_token';

/**
 * Renew this far ahead of `exp`. Generous on purpose: renewal DOES rotate the
 * token, so it must never coincide with the token actually expiring while a
 * browser is mid-session. Sync-server tokens are issued for a year, making this
 * an annual event rather than a per-restart one.
 */
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;

interface TokenClaims {
  exp?: unknown;
}

/** Reads a JWT's claims without verifying it - we minted it, we only need `exp`. */
const decodeClaims = (token: string): TokenClaims | null => {
  const segment = token.split('.')[1];
  if (!segment) return null;
  try {
    const json = Buffer.from(
      segment.replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    ).toString('utf8');
    const claims: unknown = JSON.parse(json);
    return claims && typeof claims === 'object' ? (claims as TokenClaims) : null;
  } catch {
    return null;
  }
};

/**
 * Whether a stored token can still be handed out.
 *
 * Three outcomes, deliberately distinct:
 *  - unreadable  → false. Something other than a JWT is stored (a truncated
 *    write, a hand-edited row); replacing it is the only way out.
 *  - no `exp`    → true. A non-expiring token never needs replacing, and
 *    re-minting on every call would recreate the rotation this file exists to
 *    remove.
 *  - has `exp`   → true until the renewal window opens.
 */
export const isTokenUsable = (token: string, nowMs: number = Date.now()): boolean => {
  const claims = decodeClaims(token);
  if (!claims) return false;
  if (typeof claims.exp !== 'number') return true;
  return claims.exp * 1000 - nowMs > RENEW_BEFORE_MS;
};

/**
 * Serves the one token the served web app embeds, minting it only when there
 * isn't a usable one already.
 */
export class WebappTokenProvider {
  private _cached: string | null = null;

  /**
   * `key` selects which stored token this instance owns. The container's own
   * account uses the default; multi-user gives each board its own key, because
   * every distinct token needs the same durability for the same reason.
   */
  constructor(
    private readonly _store: AuthStore,
    private readonly _mint: () => Promise<string>,
    private readonly _key: string = WEBAPP_TOKEN_SETTING_KEY,
  ) {}

  async get(): Promise<string> {
    if (this._cached && isTokenUsable(this._cached)) {
      return this._cached;
    }

    const stored = await this._store.getSetting(this._key);
    if (stored && isTokenUsable(stored)) {
      this._cached = stored;
      return stored;
    }

    const minted = await this._mint();

    if (stored) {
      // Renewal: something IS stored, it just aged out. Overwrite it.
      // Two bridges renewing at once would both mint and last-write-wins, so a
      // client could see one extra rotation. Harmless now that the migration
      // prompt is suppressed under container authority, and it is a once-a-year
      // window rather than a per-restart one.
      await this._store.setSetting(this._key, minted);
      this._cached = minted;
      return minted;
    }

    // First mint: insert-if-absent so two bridges booting together converge on
    // one token instead of each overwriting the other's.
    const settled = await this._store.getOrCreateSetting(this._key, () => minted);
    this._cached = settled;
    return settled;
  }
}
