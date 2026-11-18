import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeConfig } from '../src/config';
import { SyncClient, quotaFullError } from '../src/sync-client';

const QUOTA_BODY = JSON.stringify({
  error: 'Storage quota exceeded',
  errorCode: 'STORAGE_QUOTA_EXCEEDED',
  storageUsedBytes: 104835707,
  storageQuotaBytes: 104857600,
  autoCleanupAttempted: true,
});

describe('quotaFullError', () => {
  it('turns the sync server quota refusal into a 507 that names the usage', () => {
    const e = quotaFullError(413, QUOTA_BODY) as Error & { statusCode?: number };
    expect(e.statusCode).toBe(507);
    expect(e.message).toContain('Sync storage is full (100.0 of 100.0 MB used)');
  });

  it('leaves an nginx body-too-large 413 alone', () => {
    expect(quotaFullError(413, '<html>413 Request Entity Too Large</html>')).toBeNull();
  });

  it('leaves other statuses alone', () => {
    expect(quotaFullError(500, QUOTA_BODY)).toBeNull();
  });
});

describe('SyncClient.uploadOps when storage is full', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rejects with the 507 error, so the REST API does not answer a bare 500', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(QUOTA_BODY, { status: 413 })),
    );
    const client = new SyncClient(
      { syncServerUrl: 'http://sync', clientId: 'sp-bridge-test' } as BridgeConfig,
      async () => 'token',
    );
    await client.authenticate();

    await expect(client.uploadOps([], 0)).rejects.toMatchObject({ statusCode: 507 });
  });
});
