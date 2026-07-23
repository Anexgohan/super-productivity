/**
 * Builds sync operations shaped EXACTLY like the ones a real v18.15.1 client
 * captures (verified field-for-field against live ops in the op-log — see the
 * addTask template at serverSeq 15 of the dev dataset):
 *
 *   envelope: uuidv7 op id, clientId, actionType, opType, entityType/Id,
 *             vectorClock, timestamp, schemaVersion, isPayloadEncrypted
 *   payload:  encrypt({ actionPayload: <exact NgRx action props>,
 *              entityChanges: [] })
 *
 * Write surface is intentionally narrow (mirrors the desktop REST API's
 * ALLOWED_TASK_FIELDS) — receiving clients replay these through their own
 * reducers, so unknown/malformed shapes are a data-corruption risk.
 */
import { randomBytes } from 'node:crypto';
import { encrypt } from '@sp/sync-core';
import type { SuperSyncOperation } from '@sp/shared-schema';

export const CURRENT_SCHEMA_VERSION = 4;

/** Same alphabet as nanoid (client task ids are 21-char nanoids). */
const NANOID_ALPHABET =
  'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict';
export const nanoid = (size = 21): string => {
  const bytes = randomBytes(size);
  let id = '';
  for (let i = 0; i < size; i++) {
    id += NANOID_ALPHABET[bytes[i] & 63];
  }
  return id;
};

/** RFC 9562 UUIDv7 (time-ordered) — same format clients use for op ids. */
export const uuidv7 = (): string => {
  const now = Date.now();
  const bytes = randomBytes(16);
  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now / 2 ** 24) & 0xff;
  bytes[3] = (now / 2 ** 16) & 0xff;
  bytes[4] = (now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;
  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** Fields writable via the API — mirror of desktop's ALLOWED_TASK_FIELDS. */
export const ALLOWED_TASK_FIELDS = new Set([
  'title',
  'notes',
  'isDone',
  'doneOn',
  'timeEstimate',
  'timeSpent',
  'projectId',
  'tagIds',
  'dueDay',
  'dueWithTime',
]);

export interface NewTaskInput {
  title: string;
  projectId?: string;
  notes?: string;
  timeEstimate?: number;
  tagIds?: string[];
  dueDay?: string;
  dueWithTime?: number;
}

/** Full task entity with the same default set a real client writes. */
export const buildTaskEntity = (input: NewTaskInput): Record<string, unknown> => ({
  id: nanoid(),
  subTaskIds: [],
  timeSpentOnDay: {},
  timeSpent: 0,
  timeEstimate: input.timeEstimate ?? 0,
  isDone: false,
  title: input.title,
  tagIds: input.tagIds ?? [],
  created: Date.now(),
  attachments: [],
  projectId: input.projectId ?? 'INBOX_PROJECT',
  notes: input.notes ?? '',
  ...(input.dueDay ? { dueDay: input.dueDay } : {}),
  ...(input.dueWithTime ? { dueWithTime: input.dueWithTime } : {}),
});

export class OpFactory {
  constructor(
    private readonly clientId: string,
    private readonly encryptionPassword: string,
  ) {}

  private async _makeOp(params: {
    actionType: string;
    opType: string;
    entityType: string;
    entityId: string;
    entityIds?: string[];
    actionPayload: Record<string, unknown>;
    vectorClock: Record<string, number>;
  }): Promise<SuperSyncOperation> {
    const payloadPlain = JSON.stringify({
      actionPayload: params.actionPayload,
      entityChanges: [],
    });
    const payload = await encrypt(payloadPlain, this.encryptionPassword);
    return {
      id: uuidv7(),
      clientId: this.clientId,
      actionType: params.actionType,
      opType: params.opType,
      entityType: params.entityType,
      entityId: params.entityId,
      ...(params.entityIds ? { entityIds: params.entityIds } : {}),
      payload,
      vectorClock: params.vectorClock,
      timestamp: Date.now(),
      schemaVersion: CURRENT_SCHEMA_VERSION,
      isPayloadEncrypted: true,
    } as SuperSyncOperation;
  }

  /** [Task Shared] addTask — clone of the live client template. */
  addTask(
    task: Record<string, unknown>,
    vectorClock: Record<string, number>,
  ): Promise<SuperSyncOperation> {
    return this._makeOp({
      actionType: '[Task Shared] addTask',
      opType: 'CRT',
      entityType: 'TASK',
      entityId: task.id as string,
      actionPayload: {
        task,
        workContextId: 'TODAY',
        workContextType: 'TAG',
        isAddToBacklog: false,
        isAddToBottom: false,
      },
      vectorClock,
    });
  }

  /** [Task Shared] updateTask — NgRx Update<Task> shape { task: { id, changes } }. */
  updateTask(
    id: string,
    changes: Record<string, unknown>,
    vectorClock: Record<string, number>,
  ): Promise<SuperSyncOperation> {
    return this._makeOp({
      actionType: '[Task Shared] updateTask',
      opType: 'UPD',
      entityType: 'TASK',
      entityId: id,
      actionPayload: { task: { id, changes } },
      vectorClock,
    });
  }

  /** [Task Shared] deleteTask — expects the full task (with subTasks array). */
  deleteTask(
    task: Record<string, unknown>,
    vectorClock: Record<string, number>,
  ): Promise<SuperSyncOperation> {
    const subTaskIds = Array.isArray(task.subTaskIds) ? (task.subTaskIds as string[]) : [];
    return this._makeOp({
      actionType: '[Task Shared] deleteTask',
      opType: 'DEL',
      entityType: 'TASK',
      entityId: task.id as string,
      entityIds: [task.id as string, ...subTaskIds],
      actionPayload: { task: { ...task, subTasks: [] } },
      vectorClock,
    });
  }
}
