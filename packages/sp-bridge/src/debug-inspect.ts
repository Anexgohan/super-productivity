/**
 * Dev-only: prints the STRUCTURE (keys/types, no user content) of each op's
 * decrypted payload, to verify materializer assumptions against real data.
 */
import { decrypt } from '@sp/sync-core';
import { loadConfig } from './config';
import { SyncClient } from './sync-client';

const shape = (v: unknown, depth = 0): string => {
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    return `Array(${v.length})${v.length && depth < 2 ? `<${shape(v[0], depth + 1)}>` : ''}`;
  }
  if (typeof v === 'object') {
    if (depth >= 2) return 'object';
    const entries = Object.entries(v as Record<string, unknown>)
      .slice(0, 12)
      .map(([k, val]) => `${k}:${shape(val, depth + 1)}`);
    return `{${entries.join(', ')}}`;
  }
  return typeof v;
};

const main = async (): Promise<void> => {
  const cfg = loadConfig();
  const client = new SyncClient(cfg);
  await client.authenticate();
  const { ops } = await client.downloadOpsSince(0);

  for (const op of ops) {
    const seq = (op as { serverSeq?: number }).serverSeq;
    let payload: unknown = op.op.payload;
    if (op.op.isPayloadEncrypted && typeof op.op.payload === 'string') {
      payload = JSON.parse(await decrypt(op.op.payload, cfg.encryptionPassword));
    }
    console.log(
      `#${op.serverSeq} ${op.op.opType} ${op.op.entityType} ${op.op.actionType}\n   → ${shape(payload)}\n`,
    );
  }
};

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
