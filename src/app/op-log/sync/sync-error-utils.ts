/**
 * Utility functions for handling common sync errors.
 */
import { alertDialog } from '../../util/native-dialogs';

// anex/self-hosted: archiving frees nothing on the server and there is no plan to upgrade.
// The quota is the server's STORAGE_QUOTA_BYTES setting.
const STORAGE_QUOTA_ALERT =
  'Sync storage is full! Your changes are saved on this device but are NOT syncing to the server. ' +
  'Raise the storage quota on the sync server (STORAGE_QUOTA_BYTES) to resume syncing.';

export const handleStorageQuotaError = (message: string | undefined): boolean => {
  if (!message) {
    return false;
  }
  if (
    message.includes('STORAGE_QUOTA_EXCEEDED') ||
    message.includes('Storage quota exceeded')
  ) {
    alertDialog(STORAGE_QUOTA_ALERT);
    return true;
  }
  return false;
};

export const isStorageQuotaError = (message: string | undefined): boolean => {
  if (!message) {
    return false;
  }
  return (
    message.includes('STORAGE_QUOTA_EXCEEDED') ||
    message.includes('Storage quota exceeded')
  );
};
