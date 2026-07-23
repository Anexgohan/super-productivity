/** Dev-only: dump complete envelope + decrypted payload of one op (arg: serverSeq). */
import { decrypt } from '@sp/sync-core';
import { loadConfig } from './config';
import { SyncClient } from './sync-client';
const main = async (): Promise<void> => {
  const seq = Number(process.argv[2] ?? 15);
  const cfg = loadConfig();
  const client = new SyncClient(cfg);
  await client.authenticate();
  const { ops } = await client.downloadOpsSince(seq - 1);
  const row = ops.find((r) => r.serverSeq === seq);
  if (!row) throw new Error(`no op at seq ${seq}`);
  const payload = row.op.isPayloadEncrypted
    ? JSON.parse(await decrypt(row.op.payload as string, cfg.encryptionPassword))
    : row.op.payload;
  console.log('=== ENVELOPE ===');
  console.log(JSON.stringify({ ...row.op, payload: '<encrypted>' }, null, 1));
  console.log('=== DECRYPTED PAYLOAD ===');
  console.log(JSON.stringify(payload, null, 1));
};
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
