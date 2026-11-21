/**
 * The day the app's rules count as today, from the container's clock and the synced start-of-next-day setting, as a browser's DateService sets it.
 * The rules that add to Today, plan a day or stamp a done day read it from the state, so the bridge sets it before each batch.
 */
import type { Action } from '@ngrx/store';
import { selectMiscConfig } from '../../../src/app/features/config/store/global-config.reducer';
import { normalizeStartOfNextDayConfig } from '../../../src/app/features/config/normalize-start-of-next-day-config';
import { getStartOfNextDayDiffMs } from '../../../src/app/util/start-of-next-day.util';
import { getDbDateStr } from '../../../src/app/util/get-db-date-str';
import { AppStateActions } from '../../../src/app/root-store/app-state/app-state.actions';
import type { AppState } from '../../../src/app/root-store/app-state/app-state.reducer';
import type { RootState } from './root-reducer';

/** The action that sets the logical day, or null when the state already has it. */
export const logicalDayChange = (state: RootState, now: number): Action | null => {
  const misc = normalizeStartOfNextDayConfig(selectMiscConfig(state as never));
  const startOfNextDayDiffMs = getStartOfNextDayDiffMs(
    misc.startOfNextDayTime,
    misc.startOfNextDay,
  );
  const todayStr = getDbDateStr(now - startOfNextDayDiffMs);
  const appState = state.appState as AppState | undefined;
  if (
    appState?.todayStr === todayStr &&
    appState.startOfNextDayDiffMs === startOfNextDayDiffMs
  ) {
    return null;
  }
  return AppStateActions.setTodayString({ todayStr, startOfNextDayDiffMs });
};
