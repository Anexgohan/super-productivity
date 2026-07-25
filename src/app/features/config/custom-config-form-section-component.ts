import { FileImexComponent } from '../../imex/file-imex/file-imex.component';
import { CustomCfgSection } from './global-config.model';
import { ClipboardImagesCfgComponent } from './clipboard-images-cfg/clipboard-images-cfg.component';
import { UserAccountsCfgComponent } from '../user-accounts/user-accounts-cfg/user-accounts-cfg.component';
import { Type } from '@angular/core';

export const customConfigFormSectionComponent = (
  customSection: CustomCfgSection,
): Type<unknown> => {
  switch (customSection) {
    case 'FILE_IMPORT_EXPORT':
      return FileImexComponent;

    case 'CLIPBOARD_IMAGES_CFG':
      return ClipboardImagesCfgComponent;

    case 'USER_ACCOUNTS_CFG':
      return UserAccountsCfgComponent;

    default:
      throw new Error('Invalid component');
  }
};
