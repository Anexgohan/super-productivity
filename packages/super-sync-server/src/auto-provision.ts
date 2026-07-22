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
 * POST /api/internal/token → { token, userId, email } for the provisioned
 * account. Caller must send X-Internal-Secret: <JWT_SECRET>. Intended for the
 * web container's entrypoint on the compose-internal network only.
 */
export const provisionRoutes = async (fastify: FastifyInstance): Promise<void> => {
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

    const token = jwt.sign(
      { userId: user.id, email: user.email, tokenVersion: user.tokenVersion ?? 0 },
      getJwtSecret(),
      { expiresIn: JWT_EXPIRY },
    );

    return reply.status(200).send({ token, userId: user.id, email: user.email });
  });
};
