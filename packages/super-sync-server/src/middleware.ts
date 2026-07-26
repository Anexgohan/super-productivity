import { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken, type TokenScope } from './auth';

// User payload type
export interface AuthUser {
  userId: number;
  email: string;
  /** Absent means unrestricted. 'read' is a delegated board, where the holder is not the owner. */
  scope?: TokenScope;
}

// Extend FastifyRequest to include optional user (before auth)
declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

/**
 * Helper to get authenticated user from request.
 * Use this in route handlers protected by the authenticate preHandler hook.
 * Throws if user is not set (should never happen after authenticate hook).
 */
export const getAuthUser = (req: FastifyRequest): AuthUser => {
  if (!req.user) {
    throw new Error('User not authenticated - missing auth middleware?');
  }
  return req.user;
};

export const authenticate = async (
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | void> => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'Missing or invalid Authorization header' });
  }
  const token = authHeader.split(' ')[1];

  const result = await verifyToken(token);
  if (!result.valid) {
    return reply.code(401).send({ error: result.reason });
  }

  req.user = { userId: result.userId, email: result.email, scope: result.scope };
};

/**
 * Rejects a read-scoped token on a route that changes data.
 * Applied per-route rather than globally so a new write route cannot inherit read access by being forgotten here: it has to opt in to being writable.
 */
export const requireWriteScope = async (
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | void> => {
  if (req.user?.scope === 'read') {
    return reply.code(403).send({ error: 'Read-only token' });
  }
};
