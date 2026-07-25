import { ConfigFormSection } from '../global-config.model';
import { T } from '../../../t.const';

export const USER_ACCOUNTS_FORM_CFG: ConfigFormSection<{ [key: string]: any }> = {
  title: T.GCF.ACCOUNTS.TITLE,
  // @ts-ignore — accounts live in the bridge, not GlobalConfig, so there is no
  // config key backing this section (see the explainer, "Accounts, roles and
  // per-user boards").
  key: 'userAccounts',
  help: T.GCF.ACCOUNTS.HELP,
  customSection: 'USER_ACCOUNTS_CFG',
};
