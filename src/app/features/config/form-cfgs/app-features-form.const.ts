import { ConfigFormSection, AppFeaturesConfig } from '../global-config.model';
import { T } from '../../../t.const';
import { IS_DONATION_UI_RESTRICTED } from '../../../app.constants';
import { IS_CONTAINER_MANAGED } from '../../../imex/sync/container-authority.service';

export const EXPERIMENTAL_APP_FEATURE_KEYS: ReadonlyArray<keyof AppFeaturesConfig> = [
  'isEnableUserProfiles',
];

export const APP_FEATURES_FORM_CFG: ConfigFormSection<AppFeaturesConfig> = {
  title: T.GCF.APP_FEATURES.TITLE,
  key: 'appFeatures',
  help: T.GCF.APP_FEATURES.HELP,
  items: [
    {
      key: 'isTimeTrackingEnabled',
      type: 'slide-toggle',
      props: {
        label: T.GCF.APP_FEATURES.TIME_TRACKING,
        icon: 'play_arrow',
      },
    },
    {
      key: 'isFocusModeEnabled',
      type: 'slide-toggle',
      templateOptions: {
        label: T.GCF.APP_FEATURES.FOCUS_MODE,
        icon: 'center_focus_strong',
      },
    },
    {
      key: 'isSchedulerEnabled',
      type: 'slide-toggle',
      templateOptions: {
        label: T.GCF.APP_FEATURES.SCHEDULE,
        icon: 'schedule',
      },
    },
    {
      key: 'isPlannerEnabled',
      type: 'slide-toggle',
      templateOptions: {
        label: T.GCF.APP_FEATURES.PLANNER,
        icon: 'edit_calendar',
      },
    },
    {
      key: 'isBoardsEnabled',
      type: 'slide-toggle',
      templateOptions: {
        label: T.GCF.APP_FEATURES.BOARDS,
        icon: 'grid_view',
      },
    },
    {
      key: 'isScheduleDayPanelEnabled',
      type: 'slide-toggle',
      templateOptions: {
        label: T.GCF.APP_FEATURES.SCHEDULE_DAY_PANEL,
        icon: 'schedule',
      },
    },
    {
      key: 'isIssuesPanelEnabled',
      type: 'slide-toggle',
      templateOptions: {
        label: T.GCF.APP_FEATURES.ISSUES_PANEL,
        icon: 'webhook',
      },
    },
    {
      key: 'isProjectNotesEnabled',
      type: 'slide-toggle',
      templateOptions: {
        label: T.GCF.APP_FEATURES.PROJECT_NOTES,
        icon: 'comment',
      },
    },
    {
      key: 'isSyncIconEnabled',
      type: 'slide-toggle',
      templateOptions: {
        label: T.GCF.APP_FEATURES.SYNC_BUTTON,
        icon: 'sync',
      },
    },
    {
      key: 'isSearchEnabled',
      type: 'slide-toggle',
      templateOptions: {
        label: T.GCF.APP_FEATURES.SEARCH,
        icon: 'search',
      },
    },
    {
      key: 'isDonatePageEnabled',
      type: 'slide-toggle',
      // Donations are fully hidden on native iOS and macOS desktop builds, so
      // this toggle would be inert there — hide it to avoid a dead control.
      hideExpression: () => IS_DONATION_UI_RESTRICTED,
      templateOptions: {
        label: T.GCF.APP_FEATURES.DONATE_PAGE,
        icon: 'favorite',
      },
    },
    {
      key: 'isFinishDayEnabled',
      type: 'slide-toggle',
      templateOptions: {
        label: T.GCF.APP_FEATURES.FINISH_DAY,
        icon: 'done_all',
      },
    },
    {
      key: 'isHabitsEnabled',
      type: 'slide-toggle',
      templateOptions: {
        label: T.GCF.APP_FEATURES.HABITS,
        icon: 'heart_check',
      },
    },
    {
      key: 'isEnableUserProfiles',
      type: 'slide-toggle',
      // Container-managed deployments put identity on the server, in accounts.
      // Profiles are the browser-local answer to the same question and the two
      // cannot both be true: a switch swaps the entire dataset without changing
      // the sync token, so the server would keep taking writes from a client
      // that is now holding different data.
      hideExpression: () => IS_CONTAINER_MANAGED(),
      templateOptions: {
        label: T.GCF.APP_FEATURES.USER_PROFILES,
        description: T.GCF.APP_FEATURES.USER_PROFILES_HINT,
        icon: 'account_circle',
      },
    },
    {
      hideExpression: (m: AppFeaturesConfig) =>
        !m.isEnableUserProfiles || IS_CONTAINER_MANAGED(),
      type: 'tpl',
      templateOptions: {
        tag: 'div',
        text: T.GCF.APP_FEATURES.USER_PROFILES_WARNING,
        class: 'sync-warning',
      },
    },
  ],
};
