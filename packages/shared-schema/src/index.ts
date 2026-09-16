// Schema version constants
export {
  CURRENT_SCHEMA_VERSION,
  MIN_SUPPORTED_SCHEMA_VERSION,
  PROJECT_DELETE_WINS_SCHEMA_VERSION,
} from './schema-version';

// Types
export type {
  OperationLike,
  SchemaMigration,
  MigrationResult,
  MigratableStateCache,
} from './migration.types';

// Migration functions
export {
  migrateState,
  migrateOperation,
  migrateOperations,
  stateNeedsMigration,
  operationNeedsMigration,
  validateMigrationRegistry,
  getCurrentSchemaVersion,
} from './migrate';

// Migration registry (for inspection/debugging)
export { MIGRATIONS } from './migrations/index';

// Entity types (shared between client and server)
export type { EntityType } from './entity-types';
export { ENTITY_TYPES } from './entity-types';

// SuperSync HTTP contract (shared between client and server)
export {
  SUPER_SYNC_CLIENT_ID_REGEX,
  SUPER_SYNC_MAX_CLIENT_ID_LENGTH,
  SUPER_SYNC_MAX_OPS_PER_UPLOAD,
  SUPER_SYNC_MAX_ENTITY_IDS_PER_OP,
  SUPER_SYNC_OP_TYPES,
  SUPER_SYNC_IMPORT_REASONS,
  SUPER_SYNC_SNAPSHOT_REASONS,
  SUPER_SYNC_SNAPSHOT_OP_TYPES,
  SuperSyncVectorClockSchema,
  SuperSyncClientIdSchema,
  SuperSyncOperationSchema,
  SuperSyncUploadOpsRequestSchema,
  SuperSyncDownloadOpsQuerySchema,
  SuperSyncUploadSnapshotRequestSchema,
  SuperSyncOperationResponseSchema,
  SuperSyncServerOperationSchema,
  SuperSyncUploadResultSchema,
  SuperSyncUploadOpsResponseSchema,
  SuperSyncDownloadOpsResponseSchema,
  SuperSyncSnapshotResponseSchema,
  SuperSyncSnapshotUploadResponseSchema,
  SuperSyncStatusResponseSchema,
  SuperSyncRestorePointSchema,
  SuperSyncRestorePointsResponseSchema,
  SuperSyncRestoreSnapshotResponseSchema,
  SuperSyncDeleteAllDataResponseSchema,
} from './supersync-http-contract';
export type {
  SuperSyncOpType,
  SuperSyncImportReason,
  SuperSyncSnapshotReason,
  SuperSyncSnapshotOpType,
  SuperSyncOperation,
  SuperSyncUploadOpsRequest,
  SuperSyncDownloadOpsQuery,
  SuperSyncUploadSnapshotRequest,
  SuperSyncServerOperation,
  SuperSyncUploadResult,
  SuperSyncUploadOpsResponse,
  SuperSyncDownloadOpsResponse,
  SuperSyncSnapshotResponse,
  SuperSyncSnapshotUploadResponse,
  SuperSyncStatusResponse,
  SuperSyncRestorePoint,
  SuperSyncRestorePointsResponse,
  SuperSyncRestoreSnapshotResponse,
  SuperSyncDeleteAllDataResponse,
} from './supersync-http-contract';

// Defaults for new tasks, tags and projects (shared so API-created entities match app-created ones)
export {
  DEFAULT_PROJECT_COLOR,
  DEFAULT_TAG_COLOR,
  DEFAULT_TODAY_TAG_COLOR,
  DEFAULT_BACKGROUND_IMAGE_BLUR,
  DEFAULT_BACKGROUND_OVERLAY_OPACITY,
  PRESET_COLORS,
  getRandomWorkContextColor,
  WORK_CONTEXT_DEFAULT_THEME,
  WORKLOG_EXPORT_DEFAULTS,
  WORK_CONTEXT_DEFAULT_COMMON,
  DEFAULT_TASK,
  DEFAULT_TAG,
  DEFAULT_PROJECT,
  createTagObject,
} from './entity-defaults';
export type { WorkContextHue, WorkContextThemeDefaults } from './entity-defaults';

// Board shapes and starter boards (shared so the bridge sees what a fresh browser draws)
export {
  BoardPanelCfgTaskDoneState,
  BoardPanelCfgScheduledState,
  BoardPanelCfgTaskTypeFilter,
  BOARD_TAG_IDS,
  DEFAULT_BOARDS,
  cloneDefaultBoards,
  isAllProjects,
  sanitizeBoardProjectIds,
  reassignPanelProjectScopes,
  restrictPanelCardOrder,
} from './boards';
export {
  DEFAULT_BOARD_CFG,
  DEFAULT_PANEL_CFG,
  sanitizePanelCfg,
  sanitizeBoard,
  normalizeLoadedBoards,
  fixBuggyDefaultBoardFilters,
  repairLoadedBoards,
  addBoardToState,
  updateBoardInState,
  removeBoardFromState,
  sortBoardsInState,
  updatePanelTaskIdsInState,
} from './boards-state';
export type {
  BoardCfg,
  BoardPanelCfg,
  BoardSrcCfg,
  BoardSortField,
  BoardMatchMode,
  BoarFieldsToRemove,
} from './boards';
