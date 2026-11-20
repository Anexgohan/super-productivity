import { MatSnackBarConfig } from '@angular/material/snack-bar';
import { Observable } from 'rxjs';

export type SnackType = 'ERROR' | 'SUCCESS' | 'WARNING' | 'CUSTOM' | 'JIRA_UNBLOCK';

export interface SnackParams {
  msg: string;
  isSkipTranslate?: boolean;
  translateParams?: { [key: string]: string | number };
  type?: SnackType;
  ico?: string;
  svgIco?: string;
  actionStr?: string;
  actionId?: string;
  // eslint-disable-next-line
  actionFn?: Function;
  dismissFn?: () => void | Promise<void>;
  actionPayload?: unknown;
  config?: MatSnackBarConfig;
  isSpinner?: boolean;
  promise?: Promise<unknown>;
  showWhile$?: Observable<unknown>;
  /**
   * Routine feedback (the sync button's "synced") does not replace this snack while it shows; checked with
   * `SnackService.isKeepingMessageVisible()`. For messages the user must get to read, e.g. a checkpoint taken with
   * unsent edits kept.
   */
  isKeptVisible?: boolean;
}
