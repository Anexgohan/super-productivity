/**
 * The app-action routes (anex/app-actions) through the real REST server with a stubbed account store: who may run one, and what a
 * refusal answers. The action itself is a recorder here; app-actions.spec.ts runs it on the real worker.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { createRestServer, type AuthWiring } from '../src/rest';
import { formatApiKey } from '../src/auth/api-key';
import { SessionManager } from '../src/auth/session';
import type { ApiKeyRow, AuthStore, UserRow } from '../src/auth/store';
import type { BridgeCore } from '../src/core';
import type { StateStore } from '../src/state-store';
import type { UserBoards } from '../src/user-boards';

const SECRET = 'action-routes-test-secret';

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
const users = [user(2, 'operator'), user(3, 'viewer'), user(5, 'operator', true)];
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

const calls: { board: string; name: string; input: unknown; when: unknown }[] = [];
let refusal: Error | null = null;
let app: FastifyInstance;

beforeAll(async () => {
  const authStore = {
    findLiveApiKey: async (id: number) =>
      users.some((u) => u.id + 10 === id) ? keyRow(id - 10) : null,
    findUserById: async (id: number) => users.find((u) => u.id === id) ?? null,
    listPublicUsers: async () => users.filter((u) => u.isPublic),
    touchApiKey: async () => undefined,
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
    core: {
      act: async (name: string, input: unknown, when: unknown) => {
        if (refusal) throw refusal;
        calls.push({ board: `user-${u.id}`, name, input, when });
        return { opIds: ['op-1'], refs: {} };
      },
    } as unknown as BridgeCore,
    store: { boardName: `user-${u.id}` } as StateStore,
  });
  const boards = { forUser: async (u: UserRow) => boardOf(u) } as unknown as UserBoards;
  app = createRestServer({} as BridgeCore, {} as StateStore, auth, undefined, boards);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  calls.splice(0);
  refusal = null;
});

const run = (
  userId: number,
  name: string,
  body: unknown,
  query = '',
): Promise<LightMyRequestResponse> =>
  app.inject({
    method: 'POST',
    url: `/api/actions/${name}${query}`,
    headers: { 'x-api-key': keyOf(userId), 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });

describe('app action routes', () => {
  it("runs an action on the caller's own board with its input and time", async () => {
    const res = await run(2, 'deleteTasks', {
      input: { taskIds: ['a'] },
      when: { today: '2031-03-03' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ opIds: ['op-1'], refs: {} });
    expect(calls).toEqual([
      {
        board: 'user-2',
        name: 'deleteTasks',
        input: { taskIds: ['a'] },
        when: { today: '2031-03-03' },
      },
    ]);
  });

  it('refuses a read-only account and a board shared for reading, running nothing', async () => {
    const viewer = await run(3, 'deleteTasks', { input: { taskIds: ['a'] } });
    expect(viewer.statusCode).toBe(403);
    const shared = await run(
      2,
      'deleteTasks',
      { input: { taskIds: ['a'] } },
      '?boardOf=5',
    );
    expect(shared.statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  it('answers 404 for an unknown action and 400 naming the wrong field, running nothing', async () => {
    expect((await run(2, 'noSuchAction', {})).statusCode).toBe(404);
    const bad = await run(2, 'deleteTasks', {
      input: { taskIds: [], title: 'x' },
      when: { today: 'tomorrow' },
    });
    expect(bad.statusCode).toBe(400);
    const errors = (bad.json() as { errors: string[] }).errors;
    expect(errors.some((e) => e.startsWith('input.taskIds'))).toBe(true);
    expect(errors.some((e) => e.startsWith('input.(input)'))).toBe(true);
    expect(errors.some((e) => e.startsWith('when'))).toBe(true);
    // The values sent are never echoed back.
    expect(bad.body).not.toContain('tomorrow');
    expect(calls).toEqual([]);
  });

  it("passes the app's refusal on with its status and reasons", async () => {
    refusal = Object.assign(new Error('The change would leave the board invalid.'), {
      statusCode: 409,
      errors: ['cross-model: tagId from task not existing'],
    });
    const res = await run(2, 'addTaskRepeatCfgToTask', { input: { taskId: 't' } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'The change would leave the board invalid.',
      errors: ['cross-model: tagId from task not existing'],
    });
  });

  it('lists every action with its input as JSON Schema, to readers too', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/actions',
      headers: { 'x-api-key': keyOf(3) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      actions: Record<string, { input: { type: string; properties: object } }>;
    };
    expect(Object.keys(body.actions).sort()).toEqual(
      ['addTaskRepeatCfgToTask', 'deleteTask', 'deleteTasks', 'updateTask'].sort(),
    );
    expect(body.actions.deleteTasks.input).toMatchObject({
      type: 'object',
      properties: { taskIds: { type: 'array' } },
    });
  });
});
