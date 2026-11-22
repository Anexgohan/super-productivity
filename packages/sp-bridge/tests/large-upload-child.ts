/** Child process of large-upload.spec.ts: one import upload of argv[2] MiB through StateStore, with the server faked. */
import { encrypt } from '@sp/sync-core';
import type { AppRulesWorker } from '../src/app-rules-worker';
import type { BridgeConfig } from '../src/config';
import { StateStore } from '../src/state-store';
import type { SyncClient } from '../src/sync-client';

const main = async (): Promise<void> => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ accepted: true, serverSeq: 1 }))) as typeof fetch;
  // Derives the key up front, as a running bridge already has.
  await encrypt('warm', 'pw');
  const worker = { listen: () => () => undefined } as unknown as AppRulesWorker;
  const store = new StateStore(
    {
      syncServerUrl: 'http://s',
      encryptionPassword: 'pw',
      dataDir: '/nonexistent',
    } as BridgeConfig,
    worker,
    { mintToken: async () => 't', cacheKey: 'user-1', clientId: 'B_b-1' },
  );
  await (store as unknown as { _client: SyncClient })._client.authenticate();
  const json = new Uint8Array(Buffer.alloc(Number(process.argv[2]) * 1024 * 1024, 0x61));
  const res = await store.uploadBackupImport(await store.sealBackupImport(json), 4, {
    opId: 'op',
    vectorClock: { B: 1 },
  });
  process.stdout.write(`accepted ${res.accepted}\n`);
};

void main();
