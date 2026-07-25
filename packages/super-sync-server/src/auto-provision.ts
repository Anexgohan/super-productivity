/**
 * Container-first account auto-provisioning (anex/container-parity).
 *
 * When SP_SYNC_AUTO_PROVISION=true, the server creates a verified account from
 * SP_SYNC_ACCOUNT_EMAIL / SP_SYNC_ACCOUNT_PASSWORD at startup (idempotent), and
 * exposes POST /api/internal/token — guarded by the X-Internal-Secret header
 * (must equal JWT_SECRET) — so the web container's entrypoint can fetch an
 * access token to embed into the served frontend config.
 *
 * Differences from test-routes.ts (which this is modeled on):
 *  - NEVER deletes existing user data (test route wipes ops for a clean slate).
 *  - Does not bump tokenVersion (previously issued tokens stay valid).
 *  - Password changes in .env are applied to the account on next startup.
 *
 * Everything is inert unless SP_SYNC_AUTO_PROVISION=true (upstream behavior
 * unchanged by default).
 */
import { FastifyInstance } from 'fastify';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { prisma } from './db';
import { Logger } from './logger';
import { getJwtSecret, JWT_EXPIRY } from './auth';

const BCRYPT_ROUNDS = 12;
const MIN_PASSWORD_LENGTH = 8;

export const isAutoProvisionEnabled = (): boolean =>
  process.env.SP_SYNC_AUTO_PROVISION === 'true';

const getProvisionAccount = (): { email: string; password: string } | null => {
  const email = process.env.SP_SYNC_ACCOUNT_EMAIL?.trim();
  const password = process.env.SP_SYNC_ACCOUNT_PASSWORD;
  if (!email || !password) {
    Logger.error(
      'SP_SYNC_AUTO_PROVISION=true but SP_SYNC_ACCOUNT_EMAIL / SP_SYNC_ACCOUNT_PASSWORD missing',
    );
    return null;
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    Logger.error(
      `SP_SYNC_ACCOUNT_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`,
    );
    return null;
  }
  return { email, password };
};

/**
 * Idempotent: creates the account verified if missing; updates the password
 * hash if the .env password changed. Never touches ops/devices/sync state.
 */
export const autoProvisionAccount = async (): Promise<void> => {
  const account = getProvisionAccount();
  if (!account) return;

  const existing = await prisma.user.findUnique({ where: { email: account.email } });

  if (!existing) {
    const passwordHash = await bcrypt.hash(account.password, BCRYPT_ROUNDS);
    const user = await prisma.user.create({
      data: {
        email: account.email,
        passwordHash,
        isVerified: 1,
        verificationToken: null,
        verificationTokenExpiresAt: null,
        tokenVersion: 0,
      },
    });
    Logger.info(`[auto-provision] Created verified account (ID: ${user.id})`);
    return;
  }

  const passwordMatches =
    existing.passwordHash !== null &&
    (await bcrypt.compare(account.password, existing.passwordHash));
  if (!passwordMatches) {
    const passwordHash = await bcrypt.hash(account.password, BCRYPT_ROUNDS);
    await prisma.user.update({
      where: { id: existing.id },
      data: { passwordHash, isVerified: 1 },
    });
    Logger.info(`[auto-provision] Updated password for account (ID: ${existing.id})`);
  } else if (existing.isVerified !== 1) {
    await prisma.user.update({ where: { id: existing.id }, data: { isVerified: 1 } });
    Logger.info(`[auto-provision] Marked account verified (ID: ${existing.id})`);
  } else {
    Logger.info(`[auto-provision] Account already provisioned (ID: ${existing.id})`);
  }
};

/**
 * Creates a verified account for an arbitrary address, or returns the existing
 * one.
 *
 * The password is only ever used to CREATE. An existing account is returned
 * without checking it, and never has its hash rewritten — unlike
 * `autoProvisionAccount`, which reapplies the env password on every boot.
 *
 * That is not a hole worth closing: the only guard on this route is
 * X-Internal-Secret, which must equal JWT_SECRET, and anyone holding JWT_SECRET
 * can mint a token for any account by signing one directly. Verifying the
 * password would add no protection while breaking every caller whose derived
 * password changed because the secret was rotated.
 */
const ensureAccount = async (
  email: string,
  password: string,
): Promise<{ id: number; email: string; tokenVersion: number | null }> => {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      isVerified: 1,
      verificationToken: null,
      verificationTokenExpiresAt: null,
      tokenVersion: 0,
    },
  });
  Logger.info(`[auto-provision] Created account for a bridge user (ID: ${user.id})`);
  return user;
};

const signToken = (user: { id: number; email: string; tokenVersion: number | null }) =>
  jwt.sign(
    { userId: user.id, email: user.email, tokenVersion: user.tokenVersion ?? 0 },
    getJwtSecret(),
    { expiresIn: JWT_EXPIRY },
  );

/**
 * POST /api/internal/token → { token, userId, email } for the provisioned
 * account. Caller must send X-Internal-Secret: <JWT_SECRET>. Intended for the
 * web container's entrypoint on the compose-internal network only.
 *
 * POST /api/internal/provision → the same, for any address. This is what makes
 * more than one board possible: /token is bound to SP_SYNC_ACCOUNT_EMAIL and
 * can only ever serve the container's own account.
 */
export const provisionRoutes = async (fastify: FastifyInstance): Promise<void> => {
  fastify.post<{ Body: { email?: string; password?: string } }>(
    '/provision',
    { config: { rateLimit: false } },
    async (request, reply) => {
      const secret = request.headers['x-internal-secret'];
      if (typeof secret !== 'string' || secret !== getJwtSecret()) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const email = request.body?.email?.trim().toLowerCase();
      const password = request.body?.password;
      if (!email || !email.includes('@')) {
        return reply.status(400).send({ error: 'A valid email is required' });
      }
      if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
        return reply
          .status(400)
          .send({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      }

      const user = await ensureAccount(email, password);
      return reply
        .status(200)
        .send({ token: signToken(user), userId: user.id, email: user.email });
    },
  );

  /**
   * DELETE /api/internal/users/:id → purges an account and everything it owns.
   * Every relation to User is onDelete: Cascade, so ops, devices, sync state
   * and passkeys go with it in one statement.
   *
   * The container's own account is refused: it holds the board the stack was
   * built around, and nothing in the UI should be able to reach it.
   */
  fastify.delete<{ Params: { id: string } }>(
    '/users/:id',
    { config: { rateLimit: false } },
    async (request, reply) => {
      const secret = request.headers['x-internal-secret'];
      if (typeof secret !== 'string' || secret !== getJwtSecret()) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const id = Number.parseInt(request.params.id, 10);
      if (!Number.isFinite(id)) {
        return reply.status(400).send({ error: 'Invalid user id' });
      }

      const user = await prisma.user.findUnique({ where: { id } });
      if (!user) {
        // Already gone: the caller wants it absent, and it is.
        return reply.status(200).send({ deleted: false });
      }

      const containerAccount = process.env.SP_SYNC_ACCOUNT_EMAIL?.trim().toLowerCase();
      if (containerAccount && user.email.toLowerCase() === containerAccount) {
        return reply
          .status(400)
          .send({ error: 'Refusing to delete the container account' });
      }

      await prisma.user.delete({ where: { id } });
      Logger.info(`[auto-provision] Purged account and all its data (ID: ${id})`);
      return reply.status(200).send({ deleted: true });
    },
  );

  /**
   * GET /api/internal/users/:id/has-data → whether that account holds any ops.
   *
   * The bridge syncs one account, so it cannot answer this for anyone else, and
   * it serves the answer to browsers: a replica facing an EMPTY board is the
   * resurrection case and must be purged rather than adopted. Asked here rather
   * than read from Prisma's tables directly, so the bridge stays clear of this
   * schema (see AuthStore's note on migration isolation).
   */
  fastify.get<{ Params: { id: string } }>(
    '/users/:id/has-data',
    { config: { rateLimit: false } },
    async (request, reply) => {
      const secret = request.headers['x-internal-secret'];
      if (typeof secret !== 'string' || secret !== getJwtSecret()) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const id = Number.parseInt(request.params.id, 10);
      if (!Number.isFinite(id)) {
        return reply.status(400).send({ error: 'Invalid user id' });
      }

      // Existence, not a count: a board with 40k ops costs the same as one.
      const op = await prisma.operation.findFirst({
        where: { userId: id },
        select: { id: true },
      });
      return reply.status(200).send({ hasData: op !== null });
    },
  );

  fastify.post('/token', { config: { rateLimit: false } }, async (request, reply) => {
    const secret = request.headers['x-internal-secret'];
    if (typeof secret !== 'string' || secret !== getJwtSecret()) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const account = getProvisionAccount();
    if (!account) {
      return reply.status(503).send({ error: 'Auto-provision account not configured' });
    }

    const user = await prisma.user.findUnique({ where: { email: account.email } });
    if (!user) {
      return reply.status(503).send({ error: 'Account not provisioned yet' });
    }

    return reply
      .status(200)
      .send({ token: signToken(user), userId: user.id, email: user.email });
  });
};
