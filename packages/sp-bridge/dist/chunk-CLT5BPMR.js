// src/auth/session.ts
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
var SESSION_COOKIE = 'sp_session';
var SECRET_SETTING_KEY = 'session_secret';
var b64url = (buf) => Buffer.from(buf).toString('base64url');
var decodeSegment = (seg) => {
  try {
    return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
};
var SessionManager = class {
  _secret;
  ttlSeconds;
  _secureCookie;
  constructor(secretBase64, opts) {
    this._secret = Buffer.from(secretBase64, 'base64');
    this.ttlSeconds = opts.ttlSeconds;
    this._secureCookie = opts.secureCookie;
  }
  /** Reissue the cookie once a session has used ~1/7 of its life. */
  get renewAfterSeconds() {
    return Math.floor(this.ttlSeconds / 7);
  }
  /** Generates the persisted signing secret (called once, on first boot). */
  static generateSecret() {
    return randomBytes(32).toString('base64');
  }
  static get secretSettingKey() {
    return SECRET_SETTING_KEY;
  }
  _sign(data) {
    return createHmac('sha256', this._secret).update(data).digest();
  }
  sign(user) {
    const now = Math.floor(Date.now() / 1e3);
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
  verify(token) {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payload, signature] = parts;
    const head = decodeSegment(header);
    if (!head || head.alg !== 'HS256') return null;
    const expected = this._sign(`${header}.${payload}`);
    let provided;
    try {
      provided = Buffer.from(signature, 'base64url');
    } catch {
      return null;
    }
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return null;
    }
    const claims = decodeSegment(payload);
    if (
      !claims ||
      typeof claims.sub !== 'string' ||
      typeof claims.username !== 'string' ||
      typeof claims.role !== 'string'
    ) {
      return null;
    }
    const now = Math.floor(Date.now() / 1e3);
    if (typeof claims.exp !== 'number' || claims.exp <= now) return null;
    return {
      user: {
        userId: Number.parseInt(claims.sub, 10),
        username: claims.username,
        role: claims.role,
        // Only a positive integer counts. A tampered or malformed claim reads as "viewing nothing", which falls back to the caller's own board.
        ...(Number.isInteger(claims.viewing) && claims.viewing > 0
          ? { viewingUserId: claims.viewing }
          : {}),
      },
      ageSeconds: now - (claims.iat ?? now),
    };
  }
  cookie(token) {
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
  clearCookie() {
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
};
var parseCookies = (header) => {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name) out[name] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
};

export { SESSION_COOKIE, SessionManager, parseCookies };
