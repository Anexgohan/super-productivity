import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeConfig } from '../src/config';
import { DOWNLOAD_PAGE_SIZE, SyncClient } from '../src/sync-client';

const op = (serverSeq: number): Record<string, unknown> => ({
  serverSeq,
  receivedAt: 0,
  op: {
    id: `op-${serverSeq}`,
    clientId: 'B_test',
    actionType: '[Task Shared] updateTask',
    opType: 'UPD',
    entityType: 'TASK',
    payload: {},
    vectorClock: { B_test: serverSeq },
    timestamp: 1,
    schemaVersion: 1,
  },
});

const page = (seqs: number[], hasMore: boolean): Response =>
  new Response(JSON.stringify({ ops: seqs.map(op), hasMore, latestSeq: 3 }), {
    status: 200,
  });

const client = async (): Promise<SyncClient> => {
  const c = new SyncClient(
    { syncServerUrl: 'http://sync', clientId: 'sp-bridge-test' } as BridgeConfig,
    async () => 'token',
  );
  await c.authenticate();
  return c;
};

describe('SyncClient.downloadOpsSince paging', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks for small pages, so a page of long notes stays far below the sync server memory cap', async () => {
    const fetchMock = vi.fn(async (_url: string) => page([1], false));
    vi.stubGlobal('fetch', fetchMock);

    await (await client()).downloadOpsSince(0);

    expect(fetchMock.mock.calls[0][0]).toContain(`limit=${DOWNLOAD_PAGE_SIZE}`);
    expect(DOWNLOAD_PAGE_SIZE).toBeLessThanOrEqual(200);
  });

  it('hands each page over as it arrives and keeps none, so a full rebuild never holds the whole history', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(page([1, 2], true))
        .mockResolvedValueOnce(page([3], false)),
    );
    const pages: number[][] = [];

    const result = await (
      await client()
    ).downloadOpsSince(0, async (ops) => {
      pages.push(ops.map((o) => o.serverSeq));
    });

    expect(pages).toEqual([[1, 2], [3]]);
    expect(result.ops).toEqual([]);
    expect(result.latestSeq).toBe(3);
  });

  it('follows the cursor from the last op of each page', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page([1, 2], true))
      .mockResolvedValueOnce(page([3], false));
    vi.stubGlobal('fetch', fetchMock);

    const result = await (await client()).downloadOpsSince(0);

    expect(fetchMock.mock.calls[1][0]).toContain('sinceSeq=2');
    expect(result.ops.map((o) => o.serverSeq)).toEqual([1, 2, 3]);
  });
});
