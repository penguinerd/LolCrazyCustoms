/**
 * Map between browser `KeyboardEvent.code` strings and Win32 virtual-key
 * codes (VKs). Used by the PTT / toggle-mute rebind UI to:
 *   1. capture the user's keystroke (browser side)
 *   2. send the VK to Rust where the low-level keyboard hook compares
 *      `KBDLLHOOKSTRUCT.vkCode` against it
 *   3. display the chosen key back as a human-readable label
 *
 * Only covers keys we want to allow as global bindings. Hostile choices
 * (Esc, Tab, modifier-only) are filtered at the call site in overlay.ts.
 *
 * VK reference: https://learn.microsoft.com/en-us/windows/win32/inputdev/virtual-key-codes
 */

// Letters A-Z → VK 0x41-0x5A. Built from String.fromCharCode at module load.
function letterMap(): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 0; i < 26; i++) {
    out[`Key${String.fromCharCode(65 + i)}`] = 0x41 + i;
  }
  return out;
}

// Digits 0-9 → VK 0x30-0x39.
function digitMap(): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 0; i < 10; i++) {
    out[`Digit${i}`] = 0x30 + i;
  }
  return out;
}

// F1-F12 → VK 0x70-0x7B.
function fnKeyMap(): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 0; i < 12; i++) {
    out[`F${i + 1}`] = 0x70 + i;
  }
  return out;
}

const KEY_TO_VK: Record<string, number> = {
  ...letterMap(),
  ...digitMap(),
  ...fnKeyMap(),
  CapsLock: 0x14,
  Insert: 0x2D,
  Delete: 0x2E,
  Home: 0x24,
  End: 0x23,
  PageUp: 0x21,
  PageDown: 0x22,
  Space: 0x20,
  Backquote: 0xC0,    // `
  Backslash: 0xDC,    // \
};

// Build the reverse map at module load. Pre-render the human label per VK
// so humanizeVk is just a Record lookup.
function buildVkToHuman(): Record<number, string> {
  const out: Record<number, string> = {};
  for (const [code, vk] of Object.entries(KEY_TO_VK)) {
    out[vk] = humanLabel(code);
  }
  return out;
}

function humanLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (/^F\d+$/.test(code)) return code;
  switch (code) {
    case 'CapsLock':  return 'Caps Lock';
    case 'PageUp':    return 'Page Up';
    case 'PageDown':  return 'Page Down';
    case 'Backquote': return '`';
    case 'Backslash': return '\\';
    default:          return code;
  }
}

const VK_TO_HUMAN: Record<number, string> = buildVkToHuman();

/**
 * Translate a `KeyboardEvent.code` to its Win32 VK code. Returns null for
 * keys we deliberately don't support (rare keys, modifier-only, etc).
 */
export function browserKeyToWin32Vk(code: string): number | null {
  return KEY_TO_VK[code] ?? null;
}

/**
 * Human-readable label for a stored VK. Returns "Unknown" for any VK not
 * in our supported set (e.g. if localStorage has a value from a future
 * version that added more keys).
 */
export function humanizeVk(vk: number): string {
  return VK_TO_HUMAN[vk] ?? 'Unknown';
}
