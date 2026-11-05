// Persisted audio-device selection. Stored in localStorage so the user's
// pick survives restarts (and stays sticky between game sessions).
//
// Note on labels: navigator.mediaDevices.enumerateDevices() only returns
// device labels (names) after getUserMedia has been called and granted at
// least once on the origin. probeMicPermission() forces a brief mic
// acquisition to unlock labels — call it when opening Settings if labels
// come back empty.

const INPUT_KEY = 'lolproxchat.inputDeviceId';
const OUTPUT_KEY = 'lolproxchat.outputDeviceId';

export function getStoredInputDeviceId(): string | null {
  return localStorage.getItem(INPUT_KEY);
}

export function setStoredInputDeviceId(id: string | null): void {
  if (id) localStorage.setItem(INPUT_KEY, id);
  else localStorage.removeItem(INPUT_KEY);
}

export function getStoredOutputDeviceId(): string | null {
  return localStorage.getItem(OUTPUT_KEY);
}

export function setStoredOutputDeviceId(id: string | null): void {
  if (id) localStorage.setItem(OUTPUT_KEY, id);
  else localStorage.removeItem(OUTPUT_KEY);
}

export interface AudioDevices {
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
}

export async function listAudioDevices(): Promise<AudioDevices> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  // Chromium emits synthetic "default" and "communications" entries that
  // duplicate a real device with a "Default - …" / "Communications - …"
  // label prefix. We already offer a single "Default" entry in the UI that
  // passes no deviceId constraint, so drop those to keep the dropdown clean.
  const isSynthetic = (d: MediaDeviceInfo) =>
    d.deviceId === 'default' || d.deviceId === 'communications';
  return {
    inputs: devices.filter((d) => d.kind === 'audioinput' && !isSynthetic(d)),
    outputs: devices.filter((d) => d.kind === 'audiooutput' && !isSynthetic(d)),
  };
}

// Trigger a one-shot getUserMedia so subsequent enumerateDevices() calls
// return populated labels. Idempotent — if permission is already granted,
// the prompt does not re-appear.
export async function probeMicPermission(): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((t) => t.stop());
}
