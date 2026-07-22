/**
 * Materializes app state from a stream of SuperSync operations.
 *
 * Mirrors the semantics of two reference implementations in this repo:
 *  - server-side: packages/super-sync-server/src/sync/op-replay.ts
 *    (full-state replacement, per-op entity spread, batch DEL via entityIds,
 *    prototype-pollution guards)
 *  - client-side: modern ops wrap payloads in a MultiEntityPayload envelope
 *    ({ actionPayload, entityChanges }) — entityChanges are the authoritative
 *    state diff and MUST be applied instead of spreading the envelope itself
 *    (which would corrupt entities with actionPayload/entityChanges keys).
 *
 * Unlike the server (which cannot decrypt), the bridge holds the E2E
 * passphrase and decrypts payloads before applying — same crypto path as any
 * client (@sp/sync-core decrypt: Argon2id + AES-256-GCM incl. @noble fallback).
 */
import {
  decrypt,
  extractActionPayload,
  extractEntityFromPayload,
  extractUpdateChanges,
  isMultiEntityPayload,
} from '@sp/sync-core';
import type { SuperSyncOperation, SuperSyncServerOperation } from '@sp/shared-schema';

export type EntityMap = Record<string, Record<string, unknown>>;

const FULL_STATE_OP_TYPES = new Set(['SYNC_IMPORT', 'BACKUP_IMPORT', 'REPAIR']);

const isUnsafeKey = (key: string): boolean =>
  key === '__proto__' || key === 'constructor' || key === 'prototype';

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};

export class Materializer {
  private _state: EntityMap = {};
  private _lastServerSeq = 0;

  constructor(private readonly encryptionPassword: string) {}

  get lastServerSeq(): number {
    return this._lastServerSeq;
  }

  get state(): EntityMap {
    return this._state;
  }

  /** Restores from a persisted cache written by toCache(). */
  restoreFromCache(cache: { state: EntityMap; lastServerSeq: number }): void {
    this._state = cache.state;
    this._lastServerSeq = cache.lastServerSeq;
  }

  toCache(): { state: EntityMap; lastServerSeq: number } {
    return { state: this._state, lastServerSeq: this._lastServerSeq };
  }

  /**
   * Applies server rows in order. Each row is { serverSeq, op, receivedAt } —
   * the operation itself nests under `.op` (SuperSyncServerOperationSchema).
   */
  async applyOps(rows: SuperSyncServerOperation[]): Promise<void> {
    for (const row of rows) {
      await this._applyOp(row.op as SuperSyncOperation);
      if (row.serverSeq > this._lastServerSeq) {
        this._lastServerSeq = row.serverSeq;
      }
    }
  }

  private async _decryptPayload(op: SuperSyncOperation): Promise<unknown> {
    if (!op.isPayloadEncrypted) {
      return op.payload;
    }
    if (typeof op.payload !== 'string') {
      throw new Error(
        `sp-bridge: encrypted op ${op.id} has non-string payload`,
      );
    }
    const plaintext = await decrypt(op.payload, this.encryptionPassword);
    return JSON.parse(plaintext);
  }

  private async _applyOp(op: SuperSyncOperation): Promise<void> {
    const payload = await this._decryptPayload(op);

    // 1) Full-state ops replace everything (see op-replay.ts for rationale)
    if (FULL_STATE_OP_TYPES.has(op.opType)) {
      const fullState =
        payload && typeof payload === 'object' && 'appDataComplete' in payload
          ? (payload as { appDataComplete: unknown }).appDataComplete
          : payload;
      if (!fullState || typeof fullState !== 'object') {
        throw new Error(`sp-bridge: ${op.opType} op ${op.id} has non-object payload`);
      }
      this._state = {};
      for (const key of Object.keys(fullState as Record<string, unknown>)) {
        if (isUnsafeKey(key)) continue;
        this._state[key] = (fullState as Record<string, Record<string, unknown>>)[key];
      }
      return;
    }

    // 2) Envelope with populated entityChanges: authoritative diff.
    //    NOTE: real client ops routinely ship entityChanges as an EMPTY array
    //    (verified against live v18.15.1 data) — the action payload is then
    //    the source of truth and must be interpreted per action family.
    if (isMultiEntityPayload(payload) && payload.entityChanges.length > 0) {
      for (const change of payload.entityChanges) {
        this._applyEntityChange(
          change.entityType,
          change.entityId,
          change.opType,
          change.changes,
        );
      }
      return;
    }

    // 3) Action-applier: interpret the action payload (reducer-lite)
    this._applyFromActionPayload(op, payload);
  }

  /**
   * Payload key an entity is nested under in action payloads, per entityType
   * (e.g. addTask → { task: {...} }). Used by the sync-core extract helpers,
   * which also handle {id, changes} updates and array-payload fallbacks.
   */
  private _payloadKeyFor(entityType: string): string {
    const map: Record<string, string> = {
      TASK: 'task',
      PROJECT: 'project',
      TAG: 'tag',
      NOTE: 'note',
      BOARD: 'board',
      SIMPLE_COUNTER: 'simpleCounter',
      TASK_REPEAT_CFG: 'taskRepeatCfg',
      IMPROVEMENT: 'improvement',
      OBSTRUCTION: 'obstruction',
      METRIC: 'metric',
    };
    return map[entityType] ?? entityType.toLowerCase();
  }

  private _applyFromActionPayload(op: SuperSyncOperation, payload: unknown): void {
    const entityType = op.entityType;
    if (isUnsafeKey(entityType)) return;

    // Singletons that aren't entity maps: store as one keyed record so REST/
    // MCP consumers can read them; merged shallowly per update.
    if (entityType === 'GLOBAL_CONFIG') {
      const action = asRecord(extractActionPayload(payload));
      const sectionKey = action.sectionKey;
      const bucket = (this._state.GLOBAL_CONFIG ??= {});
      if (typeof sectionKey === 'string' && !isUnsafeKey(sectionKey)) {
        bucket[sectionKey] = {
          ...asRecord(bucket[sectionKey]),
          ...asRecord(action.sectionCfg),
        };
      }
      return;
    }
    if (entityType === 'MENU_TREE') {
      const action = asRecord(extractActionPayload(payload));
      (this._state.MENU_TREE ??= {}).tree = action as Record<string, unknown>;
      return;
    }

    const bucket = (this._state[entityType] ??= {});
    const payloadKey = this._payloadKeyFor(entityType);

    switch (op.opType) {
      case 'CRT': {
        const entity = extractEntityFromPayload(payload, payloadKey, op.entityId);
        const id =
          (entity?.id as string | undefined) ?? (op.entityId || undefined);
        if (entity && id && !isUnsafeKey(id)) {
          bucket[id] = entity;
        }
        break;
      }
      case 'UPD':
      case 'MOV': {
        const id = op.entityId;
        if (!id || isUnsafeKey(id)) break;
        const changes = extractUpdateChanges(payload, payloadKey, id);
        if (Object.keys(changes).length > 0) {
          bucket[id] = { ...asRecord(bucket[id]), ...changes };
        }
        break;
      }
      case 'DEL': {
        const ids = op.entityIds?.length
          ? op.entityIds
          : op.entityId
            ? [op.entityId]
            : [];
        for (const id of ids) {
          if (isUnsafeKey(id)) continue;
          delete bucket[id];
        }
        break;
      }
      default:
        this._applyLegacy(op, payload);
        break;
    }
  }

  private _applyEntityChange(
    entityType: string,
    entityId: string,
    opType: string,
    changes: unknown,
  ): void {
    if (isUnsafeKey(entityType) || isUnsafeKey(entityId)) return;
    const bucket = (this._state[entityType] ??= {});

    switch (opType) {
      case 'CRT':
        bucket[entityId] = asRecord(changes);
        break;
      case 'UPD':
      case 'MOV':
        bucket[entityId] = { ...asRecord(bucket[entityId]), ...asRecord(changes) };
        break;
      case 'DEL':
        delete bucket[entityId];
        break;
      default:
        // Unknown change type: merge conservatively (matches server UPD path)
        bucket[entityId] = { ...asRecord(bucket[entityId]), ...asRecord(changes) };
        break;
    }
  }

  private _applyLegacy(op: SuperSyncOperation, payload: unknown): void {
    const entityType = op.entityType;
    const entityId = op.entityId ?? null;
    if (isUnsafeKey(entityType)) return;
    const bucket = (this._state[entityType] ??= {});

    switch (op.opType) {
      case 'CRT':
      case 'UPD':
      case 'MOV':
        if (entityId && !isUnsafeKey(entityId)) {
          bucket[entityId] = { ...asRecord(bucket[entityId]), ...asRecord(payload) };
        }
        break;
      case 'DEL': {
        const ids = op.entityIds?.length ? op.entityIds : entityId ? [entityId] : [];
        for (const id of ids) {
          if (isUnsafeKey(id)) continue;
          delete bucket[id];
        }
        break;
      }
      case 'BATCH': {
        const batch = asRecord(payload);
        const entities = asRecord(batch.entities);
        if (Object.keys(entities).length > 0) {
          for (const [id, entity] of Object.entries(entities)) {
            if (isUnsafeKey(id)) continue;
            bucket[id] = { ...asRecord(bucket[id]), ...asRecord(entity) };
          }
        } else if (entityId && !isUnsafeKey(entityId)) {
          bucket[entityId] = { ...asRecord(bucket[entityId]), ...batch };
        }
        break;
      }
      default:
        break;
    }
  }
}
