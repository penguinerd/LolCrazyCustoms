import { invoke } from '@tauri-apps/api/core';

export interface UpdateInfo {
  current_version: string;
  latest_version: string;
  update_available: boolean;
  download_url: string | null;
  notes: string | null;
}

const STORAGE_KEY = 'proxchat.autoUpdate';

export function isAutoUpdateEnabled(): boolean {
  return localStorage.getItem(STORAGE_KEY) === '1';
}

export function setAutoUpdateEnabled(enabled: boolean): void {
  localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
}

export async function checkForUpdate(): Promise<UpdateInfo> {
  return invoke<UpdateInfo>('check_for_update');
}

export async function downloadAndApply(downloadUrl: string): Promise<void> {
  await invoke('download_and_apply_update', { url: downloadUrl });
}
