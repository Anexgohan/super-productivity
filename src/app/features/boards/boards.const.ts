/**
 * The starter boards moved to `@sp/shared-schema` so the bridge holds the same list.
 * Nothing reaches the op-log until a board is edited, so without a shared copy the bridge saw no boards while the browser was plainly drawing two.
 * An API caller trusting that answer would then create a duplicate of a board it could not see.
 */
export { DEFAULT_BOARDS } from '@sp/shared-schema';

/** New-board and new-column defaults are shared so the board editor and the REST API create the same thing. */
export { DEFAULT_BOARD_CFG, DEFAULT_PANEL_CFG } from '@sp/shared-schema';
