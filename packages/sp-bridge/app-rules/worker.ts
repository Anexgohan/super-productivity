/**
 * App rules worker entry (anex/state-check).
 *
 * Runs in its own thread with its own globals and heap cap: a failure here ends this worker, never the bridge.
 * Requests are handled strictly in arrival order, one at a time, so a snapshot always reflects every page sent before it.
 */
import './globals';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { parentPort } from 'node:worker_threads';
import type { StateCheckRequest, StateCheckResponse } from '../src/state-check-protocol';
import { AppRules, APP_RULES_CACHE_VERSION, type AppRulesCache } from './app-rules';

if (!parentPort) throw new Error('app rules: must run as a worker thread');
const port = parentPort;

let rules: AppRules | undefined;
let cachePath = '';

const persist = (): void => {
  if (!rules) return;
  const tmp = `${cachePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(rules.toCache()));
  renameSync(tmp, cachePath);
};

const handle = async (req: StateCheckRequest): Promise<StateCheckResponse> => {
  if (req.kind === 'init') {
    cachePath = req.init.cachePath;
    rules = new AppRules(req.init.clientId);
    if (existsSync(cachePath)) {
      try {
        const cache = JSON.parse(readFileSync(cachePath, 'utf-8')) as AppRulesCache;
        if (cache.version === APP_RULES_CACHE_VERSION) rules.restore(cache);
        else
          console.warn(
            'sp-bridge state check: app rules cache from another version; rebuilding from seq 0',
          );
      } catch {
        console.warn(
          'sp-bridge state check: app rules cache unreadable; rebuilding from seq 0',
        );
      }
    }
    return {
      id: req.id,
      ok: true,
      kind: 'init',
      seq: rules.seq,
      sawArchiveOp: rules.sawArchiveOp,
    };
  }
  if (!rules) throw new Error('not initialized');
  if (req.kind === 'apply') {
    const before = rules.seq;
    const result = await rules.applyRows(req.rows);
    if (rules.seq !== before) persist();
    return { id: req.id, ok: true, kind: 'apply', result };
  }
  return { id: req.id, ok: true, kind: 'snapshot', snapshot: await rules.snapshot() };
};

let queue: Promise<void> = Promise.resolve();
port.on('message', (req: StateCheckRequest) => {
  queue = queue.then(async () => {
    let res: StateCheckResponse;
    try {
      res = await handle(req);
    } catch (err) {
      res = {
        id: req.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    port.postMessage(res);
  });
});
