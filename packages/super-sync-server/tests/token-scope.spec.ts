/**
 * Read-scoped tokens.
 *
 * A published board is delegated by handing the reader a token minted for the board's OWNER. The sync API authenticates by token alone and is served on the
 * same public origin as the app, so without a scope that token is a full write credential for somebody else's data, whatever the bridge's own role check says.
 */
import { describe, it, expect, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { requireWriteScope } from '../src/middleware';

const replyStub = (): FastifyReply & { sent?: { code: number; body: unknown } } => {
  const reply = {
    sent: undefined as { code: number; body: unknown } | undefined,
    code(code: number) {
      this._code = code;
      return this;
    },
    send(body: unknown) {
      this.sent = { code: this._code, body };
      return this;
    },
    _code: 200,
  };
  return reply as unknown as FastifyReply & { sent?: { code: number; body: unknown } };
};

const reqWith = (user: unknown): FastifyRequest => ({ user }) as FastifyRequest;

describe('requireWriteScope', () => {
  it('rejects a read-scoped token with 403', async () => {
    const reply = replyStub();
    await requireWriteScope(reqWith({ userId: 1, email: 'a@b.c', scope: 'read' }), reply);
    expect(reply.sent).toEqual({ code: 403, body: { error: 'Read-only token' } });
  });

  it('allows a token with no scope, which is every token minted before this existed', async () => {
    const reply = replyStub();
    await requireWriteScope(reqWith({ userId: 1, email: 'a@b.c' }), reply);
    expect(reply.sent).toBeUndefined();
  });

  it('allows an explicitly undefined scope', async () => {
    const reply = replyStub();
    await requireWriteScope(
      reqWith({ userId: 1, email: 'a@b.c', scope: undefined }),
      reply,
    );
    expect(reply.sent).toBeUndefined();
  });

  it('does not throw when no user is attached, leaving authenticate to answer that', async () => {
    const reply = replyStub();
    await requireWriteScope(reqWith(undefined), reply);
    expect(reply.sent).toBeUndefined();
  });
});

describe('the write routes opt in', () => {
  /**
   * Guards the decision rather than the wiring: a route added later that changes data must name requireWriteScope itself.
   * Reading the source keeps this honest without standing up Fastify, Prisma and a database for what is a one-line policy check.
   */
  it('gates every route that changes data', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(
      new URL('../src/sync/sync.routes.ts', import.meta.url),
      'utf-8',
    );

    // Route registrations that change data, paired with the option block each one must carry.
    const writeRoutes = [
      {
        call: "fastify.post<{ Body: UploadOpsRequest }>(\n    '/ops'",
        name: 'POST /ops',
      },
      {
        call: "fastify.post<{ Body: unknown }>(\n    '/snapshot'",
        name: 'POST /snapshot',
      },
      { call: "fastify.delete(\n    '/data'", name: 'DELETE /data' },
    ];

    for (const route of writeRoutes) {
      const at = src.indexOf(route.call);
      expect(at, `${route.name} registration not found`).toBeGreaterThan(-1);
      // The options object follows the path immediately, so the guard belongs well within the next few lines.
      const optionsBlock = src.slice(at, at + 600);
      expect(optionsBlock, `${route.name} is not gated`).toContain(
        'preHandler: requireWriteScope',
      );
    }
  });

  it('leaves the download route ungated, or a published board could not be read at all', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(
      new URL('../src/sync/sync.routes.ts', import.meta.url),
      'utf-8',
    );
    const at = src.indexOf("  }>(\n    '/ops',\n    {\n      config:");
    expect(at, 'GET /ops registration not found').toBeGreaterThan(-1);
    expect(src.slice(at, at + 600)).not.toContain('requireWriteScope');
  });
});
