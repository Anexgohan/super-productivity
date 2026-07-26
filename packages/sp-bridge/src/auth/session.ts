/**
 * Browser sessions - HS256 JWT in an httpOnly cookie.
 *
 * Signed with a secret that is generated once and PERSISTED in the auth store,
 * so sessions survive container restarts. That property is the whole point: the
 * failure this system was built to eliminate was a credential that silently
 * changed underneath a browser on every restart.
 *
 * Implemented on node:crypto rather than a JWT library - HS256 is an HMAC over
 * two base64url segments, and avoiding the dependency keeps the bridge image
 * self-contained. The security-relevant details are handled explicitly:
 *  - the `alg` header is pinned to HS256 (rejects "none"/algorithm confusion)
 *  - signature comparison is timing-safe
 *  - expiry is enforced on every verify
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'sp_session';
const SECRET_SETTING_KEY = 'session_secret';

export interface SessionUser {
  userId: number;
  username: string;
  role: string;
  /**
   * Whose published board this browser is currently reading, when it is not their own.
   *
   * Lives in the session rather than on the account because it is a property of this browser, not of the person: the same account can read a colleague's board
   * in one window and their own in another. Switching reissues the cookie, and it is signed, so a viewer cannot name a board they were not granted.
   */
  viewingUserId?: number;
}

export interface VerifiedSession {
  user: SessionUser;
  /** Seconds since issuance - drives sliding renewal. */
  ageSeconds: number;
}

const b64url = (buf: Buffer | string): string => Buffer.from(buf).toString('base64url');

const decodeSegment = (seg: string): unknown => {
  try {
    return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
};

export interface SessionOptions {
  ttlSeconds: number;
  /** Set the cookie's Secure flag (omit for plain-HTTP LAN deployments). */
  secureCookie: boolean;
}

export class SessionManager {
  private readonly _secret: Buffer;
  readonly ttlSeconds: number;
  private readonly _secureCookie: boolean;

  constructor(secretBase64: string, opts: SessionOptions) {
    this._secret = Buffer.from(secretBase64, 'base64');
    this.ttlSeconds = opts.ttlSeconds;
    this._secureCookie = opts.secureCookie;
  }

  /** Reissue the cookie once a session has used ~1/7 of its life. */
  get renewAfterSeconds(): number {
    return Math.floor(this.ttlSeconds / 7);
  }

  /** Generates the persisted signing secret (called once, on first boot). */
  static generateSecret(): string {
    return randomBytes(32).toString('base64');
  }

  static get secretSettingKey(): string {
    return SECRET_SETTING_KEY;
  }

  private _sign(data: string): Buffer {
    return createHmac('sha256', this._secret).update(data).digest();
  }

  sign(user: SessionUser): string {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = b64url(
      JSON.stringify({
        sub: String(user.userId),
        username: user.username,
        role: user.role,
        ...(user.viewingUserId ? { viewing: user.viewingUserId } : {}),
        iat: now,
        exp: now + this.ttlSeconds,
      }),
    );
    const body = `${header}.${payload}`;
    return `${body}.${b64url(this._sign(body))}`;
  }

  verify(token: string): VerifiedSession | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payload, signature] = parts;

    // Pin the algorithm: never let the token choose how it is verified.
    const head = decodeSegment(header) as { alg?: string } | null;
    if (!head || head.alg !== 'HS256') return null;

    const expected = this._sign(`${header}.${payload}`);
    let provided: Buffer;
    try {
      provided = Buffer.from(signature, 'base64url');
    } catch {
      return null;
    }
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return null;
    }

    const claims = decodeSegment(payload) as {
      sub?: string;
      username?: string;
      role?: string;
      viewing?: number;
      iat?: number;
      exp?: number;
    } | null;
    if (
      !claims ||
      typeof claims.sub !== 'string' ||
      typeof claims.username !== 'string' ||
      typeof claims.role !== 'string'
    ) {
      return null;
    }
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp <= now) return null;

    return {
      user: {
        userId: Number.parseInt(claims.sub, 10),
        username: claims.username,
        role: claims.role,
        // Only a positive integer counts. A tampered or malformed claim reads as "viewing nothing", which falls back to the caller's own board.
        ...(Number.isInteger(claims.viewing) && (claims.viewing as number) > 0
          ? { viewingUserId: claims.viewing }
          : {}),
      },
      ageSeconds: now - (claims.iat ?? now),
    };
  }

  cookie(token: string): string {
    const attrs = [
      `${SESSION_COOKIE}=${token}`,
      'HttpOnly',
      'SameSite=Lax',
      'Path=/',
      `Max-Age=${this.ttlSeconds}`,
    ];
    if (this._secureCookie) attrs.push('Secure');
    return attrs.join('; ');
  }

  clearCookie(): string {
    const attrs = [
      `${SESSION_COOKIE}=`,
      'HttpOnly',
      'SameSite=Lax',
      'Path=/',
      'Max-Age=0',
    ];
    if (this._secureCookie) attrs.push('Secure');
    return attrs.join('; ');
  }
}

/**
 * Minimal Cookie-header parser. Fastify has no cookie plugin here, and the
 * WebSocket upgrade path would not run it anyway.
 */
export const parseCookies = (header: string | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name) out[name] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
};
