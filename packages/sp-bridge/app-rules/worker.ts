/**
 * App rules worker entry (anex/app-rules).
 *
 * Runs in its own thread with its own globals and heap cap: a failure here ends this worker, never the bridge.
 * Holds one set of app rules per resident board, each with its own cache file. Requests are handled strictly in arrival
 * order, one at a time, so a snapshot always reflects every page sent before it for that board.
 */
import './globals';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { parentPort } from 'node:worker_threads';
import type { AppRulesRequest, AppRulesResponse } from '../src/app-rules-protocol';
import { AppRules, APP_RULES_CACHE_VERSION, type AppRulesCache } from './app-rules';

if (!parentPort) throw new Error('app rules: must run as a worker thread');
const port = parentPort;

const boards = new Map<string, { rules: AppRules; cachePath: string }>();

const persist = (board: { rules: AppRules; cachePath: string }): void => {
  const tmp = `${board.cachePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(board.rules.toCache()));
  renameSync(tmp, board.cachePath);
};

const handle = async (req: AppRulesRequest): Promise<AppRulesResponse> => {
  if (req.kind === 'init') {
    const { cachePath, clientId, checkpointHeldBack = null } = req.init;
    const rules = new AppRules(clientId);
    if (existsSync(cachePath)) {
      try {
        const cache = JSON.parse(readFileSync(cachePath, 'utf-8')) as AppRulesCache;
        if (cache.version === APP_RULES_CACHE_VERSION) {
          rules.restore(cache, checkpointHeldBack);
        } else
          console.warn(
            `sp-bridge app rules: ${req.board}: cache from another version; rebuilding from seq 0`,
          );
      } catch {
        console.warn(
          `sp-bridge app rules: ${req.board}: cache unreadable; rebuilding from seq 0`,
        );
      }
    }
    boards.set(req.board, { rules, cachePath });
    return {
      id: req.id,
      ok: true,
      kind: 'init',
      seq: rules.seq,
      sawArchiveOp: rules.sawArchiveOp,
      mergedClock: rules.mergedClock,
      checkpointHeldBack: rules.checkpointHeldBack,
    };
  }
  if (req.kind === 'close') {
    boards.delete(req.board);
    return { id: req.id, ok: true, kind: 'close' };
  }
  const board = boards.get(req.board);
  if (!board) throw new Error(`board ${req.board} is not open`);
  if (req.kind === 'apply') {
    const before = board.rules.seq;
    const result = await board.rules.applyRows(req.rows);
    if (board.rules.seq !== before) persist(board);
    return { id: req.id, ok: true, kind: 'apply', result };
  }
  if (req.kind === 'export') {
    const { bytes } = await board.rules.exportBackup();
    return { id: req.id, ok: true, kind: 'export', bytes };
  }
  if (req.kind === 'export-file') {
    const { seq, bytes } = await board.rules.exportBackup();
    const tmp = `${req.path}.tmp`;
    writeFileSync(tmp, new Uint8Array(bytes));
    renameSync(tmp, req.path);
    return { id: req.id, ok: true, kind: 'export-file', seq, size: bytes.byteLength };
  }
  if (req.kind === 'act') {
    return {
      id: req.id,
      ok: true,
      kind: 'act',
      result: await board.rules.act(req.name, req.input, req.when),
    };
  }
  if (req.kind === 'checkpoint') {
    return {
      id: req.id,
      ok: true,
      kind: 'checkpoint',
      checkpoint: await board.rules.checkpoint(),
    };
  }
  return {
    id: req.id,
    ok: true,
    kind: 'snapshot',
    snapshot: await board.rules.snapshot(),
  };
};

/** Byte replies move to the bridge rather than being copied. */
const transferOf = (res: AppRulesResponse): ArrayBuffer[] => {
  if (!res.ok) return [];
  if (res.kind === 'export') return [res.bytes];
  return [];
};

let queue: Promise<void> = Promise.resolve();
port.on('message', (req: AppRulesRequest) => {
  queue = queue.then(async () => {
    let res: AppRulesResponse;
    try {
      res = await handle(req);
    } catch (err) {
      const refusal = err as { statusCode?: unknown; errors?: unknown };
      res = {
        id: req.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        ...(typeof refusal.statusCode === 'number'
          ? { statusCode: refusal.statusCode }
          : {}),
        ...(Array.isArray(refusal.errors) ? { errors: refusal.errors as string[] } : {}),
      };
    }
    port.postMessage(res, transferOf(res));
  });
});
