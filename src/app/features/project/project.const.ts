import { Project } from './project.model';
import { DEFAULT_PROJECT as SHARED_DEFAULT_PROJECT } from '@sp/shared-schema';
import {
  WORK_CONTEXT_DEFAULT_COMMON,
  WORK_CONTEXT_DEFAULT_THEME,
} from '../work-context/work-context.const';

export const DEFAULT_PROJECT_ICON = 'list_alt';
export const _MISSING_PROJECT_ = 'missing project';

export const DEFAULT_PROJECT: Project = {
  ...SHARED_DEFAULT_PROJECT,
  advancedCfg: WORK_CONTEXT_DEFAULT_COMMON.advancedCfg,
};
export const LEGACY_NO_LIST_TAG_ID = 'NO_LIST' as const;
export const INBOX_PROJECT: Project = {
  ...DEFAULT_PROJECT,
  ...WORK_CONTEXT_DEFAULT_COMMON,
  icon: 'inbox',
  title: 'Inbox',
  // _TAG to distinguish from legacy default project
  id: 'INBOX_PROJECT',
  theme: {
    ...WORK_CONTEXT_DEFAULT_THEME,
    primary: 'rgb(144, 187, 165)',
    backgroundImageDark: '',
    isDisableBackgroundTint: false,
  },
};
