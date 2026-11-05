// Privacy-related user preferences. Currently just the "force TURN relay"
// toggle, which hides the user's public IP from peers by routing all WebRTC
// media through the TURN server instead of direct P2P. Default on since
// 2026-10-16 (it costs ~20-100 ms); stored as '1' or '0', a missing key is on.
// Before then "off" was stored by removing the key, so an install that had it
// off reads as on after the update.

const FORCE_TURN_KEY = 'lolproxchat.forceTurnRelay';

export function getForceTurnRelay(): boolean {
  try {
    return localStorage.getItem(FORCE_TURN_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setForceTurnRelay(enabled: boolean): void {
  localStorage.setItem(FORCE_TURN_KEY, enabled ? '1' : '0');
}
