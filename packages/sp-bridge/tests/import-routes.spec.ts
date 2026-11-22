/**
 * The guard and body limit of the whole-board routes, through the real REST server with a stubbed account store.
 * The import itself is replaced by a recorder; board-transfer.spec.ts tests it on the real worker.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { createRestServer, type AuthWiring } from '../src/rest';
import { formatApiKey } from '../src/auth/api-key';
import { hashPassword } from '../src/auth/passwords';
import { SessionManager } from '../src/auth/session';
import type { ApiKeyRow, AuthStore, UserRow } from '../src/auth/store';
import {
  callerPasswordFrom,
  mayWriteOtherBoard,
  needsCallerPassword,
} from '../src/auth/principal';
import type { BridgeCore } from '../src/core';
import type { StateStore } from '../src/state-store';
import type { UserBoards } from '../src/user-boards';
import { IMPORT_BODY_LIMIT_BYTES } from '../src/board-transfer';

const imports = vi.hoisted(() => [] as { board: string; size: number }[]);
vi.mock('../src/board-transfer', async (original) => ({
  ...(await original<typeof import('../src/board-transfer')>()),
  importBoard: async (store: { boardName: string }, body: Buffer) => {
    imports.push({ board: store.boardName, size: body.length });
    return { imported: true };
  },
  exportBoard: async (store: { boardName: string }) =>
    Buffer.from(JSON.stringify({ board: store.boardName })),
}));

const SECRET = 'import-routes-test-secret';
const PASSWORD = 'correct horse battery';

const user = (id: number, role: string, isPublic = false): UserRow => ({
  id,
  username: `user${id}`,
  passwordHash: '',
  role,
  email: null,
  supersyncUserId: id,
  isPublic,
  sortOrder: null,
});
const users = [
  user(1, 'admin'),
  user(2, 'operator'),
  user(3, 'viewer'),
  user(4, 'operator'),
  user(5, 'operator', true),
];
const keyRow = (userId: number): ApiKeyRow => ({
  id: userId + 10,
  userId,
  label: 'test',
  salt: `salt-${userId}`,
  version: 1,
  createdAt: 0,
  lastUsedAt: null,
  revokedAt: null,
});
const keyOf = (userId: number): string =>
  formatApiKey(SECRET, {
    userId,
    keyId: userId + 10,
    salt: `salt-${userId}`,
    version: 1,
  });

let app: FastifyInstance;

beforeAll(async () => {
  // The operator holds a real password too, so only the role keeps it out.
  users[0].passwordHash = users[1].passwordHash = await hashPassword(PASSWORD);
  const authStore = {
    findLiveApiKey: async (id: number) =>
      users.some((u) => u.id + 10 === id) ? keyRow(id - 10) : null,
    findUserById: async (id: number) => users.find((u) => u.id === id) ?? null,
    listPublicUsers: async () => users.filter((u) => u.isPublic),
    touchApiKey: async () => undefined,
    setPassword: async () => undefined,
  } as unknown as AuthStore;
  const auth: AuthWiring = {
    store: authStore,
    sessions: new SessionManager(Buffer.from(SECRET).toString('base64'), {
      ttlSeconds: 3600,
      secureCookie: false,
    }),
    jwtSecret: SECRET,
    override: {
      baseUrl: '/sync',
      encryptKey: 'unused',
      encryptSalt: async () => 'unused',
      identities: { isContainerAccount: async () => false } as never,
      boardHasData: async () => true,
      instanceId: async () => 'test',
    },
  };
  const boardOf = (u: UserRow): { core: BridgeCore; store: StateStore } => ({
    core: {} as BridgeCore,
    store: { boardName: `user-${u.id}`, dataDir: '/nonexistent' } as StateStore,
  });
  const boards = { forUser: async (u: UserRow) => boardOf(u) } as unknown as UserBoards;
  app = createRestServer({} as BridgeCore, {} as StateStore, auth, undefined, boards);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  imports.splice(0);
});

const importAs = (
  userId: number,
  opts: { password?: string; query?: string; body?: Buffer; contentType?: string } = {},
): Promise<LightMyRequestResponse> =>
  app.inject({
    method: 'POST',
    url: `/api/import${opts.query ?? ''}`,
    headers: {
      'x-api-key': keyOf(userId),
      'content-type': opts.contentType ?? 'application/json',
      ...(opts.password ? { 'x-current-password': opts.password } : {}),
    },
    payload: opts.body ?? Buffer.from('{"task":{}}'),
  });

describe('guard rules', () => {
  it('lets only an admin import into another board, and nothing else write there', () => {
    expect(mayWriteOtherBoard('POST', '/api/import', 'admin')).toBe(true);
    expect(mayWriteOtherBoard('POST', '/api/import', 'operator')).toBe(false);
    expect(mayWriteOtherBoard('PATCH', '/api/tasks/:id', 'admin')).toBe(false);
    expect(mayWriteOtherBoard('DELETE', '/api/projects/:id', 'admin')).toBe(false);
    expect(mayWriteOtherBoard('GET', '/api/import', 'admin')).toBe(false);
  });

  it('asks a key for the password on the import, in the header', () => {
    expect(needsCallerPassword('POST', '/api/import', undefined)).toBe(true);
    expect(
      callerPasswordFrom(
        '/api/import',
        { 'x-current-password': 'p' },
        { currentPassword: 'q' },
      ),
    ).toBe('p');
    expect(
      callerPasswordFrom('/api/auth/users/:id/keys', {}, { currentPassword: 'q' }),
    ).toBe('q');
  });
});

describe('POST /api/import', () => {
  it('refuses a viewer and an operator', async () => {
    expect((await importAs(3, { password: PASSWORD })).statusCode).toBe(403);
    expect((await importAs(2, { password: PASSWORD })).statusCode).toBe(403);
    expect(imports).toHaveLength(0);
  });

  it('refuses an admin key without its password or with a wrong one', async () => {
    const none = await importAs(1);
    expect(none.statusCode).toBe(403);
    expect(none.json().error).toContain('X-Current-Password');
    expect((await importAs(1, { password: 'wrong' })).statusCode).toBe(403);
    expect(imports).toHaveLength(0);
  });

  it("lets an admin with the password import into any account's board, shared or not", async () => {
    const res = await importAs(1, { password: PASSWORD, query: '?boardOf=4' });
    expect(res.statusCode).toBe(200);
    expect(imports).toEqual([{ board: 'user-4', size: 11 }]);
    expect(
      (await importAs(1, { password: PASSWORD, query: '?boardOf=99' })).statusCode,
    ).toBe(404);
  });

  it("still refuses an admin every other write to another account's board", async () => {
    for (const [method, url] of [
      ['PATCH', '/api/tasks/x?boardOf=4'],
      ['DELETE', '/api/projects/x?boardOf=4'],
      ['PATCH', '/api/tasks/x?boardOf=5'],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: { 'x-api-key': keyOf(1), 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it('takes a body over the default limit and of any content type, and refuses one over 30 MB naming the limit', async () => {
    const big = Buffer.alloc(2 * 1024 * 1024, 0x20);
    const ok = await importAs(1, {
      password: PASSWORD,
      body: big,
      contentType: 'application/x-www-form-urlencoded',
    });
    expect(ok.statusCode).toBe(200);
    expect(imports).toEqual([{ board: 'user-1', size: big.length }]);

    const tooBig = await importAs(1, {
      password: PASSWORD,
      body: Buffer.alloc(IMPORT_BODY_LIMIT_BYTES + 1, 0x20),
    });
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.json().error).toContain('30 MB');
    expect(imports).toHaveLength(1);
  });
});

describe('the password rule follows the matched route', () => {
  it('asks a key for the password however the path is spelled', async () => {
    const got: unknown[] = [];
    const wanted: unknown[] = [];
    for (const [method, url, payload] of [
      ['POST', '/api/%69mport', '{}'],
      ['POST', '/api/auth/users/1/%6beys', '{"label":"x"}'],
      ['POST', '/api/auth/users/1/keys/11/%72evoke', '{}'],
      ['DELETE', '/api/auth/users/1/keys/%31%31', undefined],
      ['PUT', '/api/auth/users/4/%70ublic', '{"isPublic":true}'],
      ['PUT', '/api/auth/users/%34', '{"role":"admin"}'],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: {
          'x-api-key': keyOf(1),
          ...(payload ? { 'content-type': 'application/json' } : {}),
        },
        ...(payload ? { payload } : {}),
      });
      got.push([method, url, res.statusCode, res.json().error]);
      wanted.push([method, url, 403, expect.stringContaining('account password')]);
    }
    expect(got).toEqual(wanted);
    expect(imports).toHaveLength(0);
  });
});

describe('GET /api/export', () => {
  it("reads the caller's own board for any role, and refuses another account's", async () => {
    const own = await app.inject({
      method: 'GET',
      url: '/api/export',
      headers: { 'x-api-key': keyOf(3) },
    });
    expect(own.statusCode).toBe(200);
    expect(own.json()).toEqual({ board: 'user-3' });
    expect(own.headers['content-disposition']).toMatch(
      /^attachment; filename="sp-backup_/,
    );
    for (const other of [4, 5]) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/export?boardOf=${other}`,
        headers: { 'x-api-key': keyOf(1) },
      });
      expect(res.statusCode).toBe(403);
    }
  });
});
