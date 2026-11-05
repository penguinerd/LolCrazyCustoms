import { browserKeyToWin32Vk, humanizeVk } from '../../src/core/keymap';

describe('browserKeyToWin32Vk', () => {
  test('maps letters A-Z to VK 0x41-0x5A', () => {
    expect(browserKeyToWin32Vk('KeyA')).toBe(0x41);
    expect(browserKeyToWin32Vk('KeyM')).toBe(0x4D);
    expect(browserKeyToWin32Vk('KeyZ')).toBe(0x5A);
  });

  test('maps digits 0-9 to VK 0x30-0x39', () => {
    expect(browserKeyToWin32Vk('Digit0')).toBe(0x30);
    expect(browserKeyToWin32Vk('Digit5')).toBe(0x35);
    expect(browserKeyToWin32Vk('Digit9')).toBe(0x39);
  });

  test('maps F1-F12 to VK 0x70-0x7B', () => {
    expect(browserKeyToWin32Vk('F1')).toBe(0x70);
    expect(browserKeyToWin32Vk('F12')).toBe(0x7B);
  });

  test('maps common special keys', () => {
    expect(browserKeyToWin32Vk('CapsLock')).toBe(0x14);
    expect(browserKeyToWin32Vk('Insert')).toBe(0x2D);
    expect(browserKeyToWin32Vk('Delete')).toBe(0x2E);
    expect(browserKeyToWin32Vk('Space')).toBe(0x20);
    expect(browserKeyToWin32Vk('Backquote')).toBe(0xC0);
  });

  test('returns null for unmappable codes', () => {
    expect(browserKeyToWin32Vk('SomeWeirdKey')).toBeNull();
    expect(browserKeyToWin32Vk('')).toBeNull();
    expect(browserKeyToWin32Vk('ShiftLeft')).toBeNull();  // modifier — not supported as binding
  });
});

describe('humanizeVk', () => {
  test('returns canonical labels for round-trip with browserKeyToWin32Vk', () => {
    expect(humanizeVk(0x14)).toBe('Caps Lock');
    expect(humanizeVk(0x41)).toBe('A');
    expect(humanizeVk(0x5A)).toBe('Z');
    expect(humanizeVk(0x30)).toBe('0');
    expect(humanizeVk(0x39)).toBe('9');
    expect(humanizeVk(0x70)).toBe('F1');
    expect(humanizeVk(0x7B)).toBe('F12');
    expect(humanizeVk(0x2D)).toBe('Insert');
    expect(humanizeVk(0x20)).toBe('Space');
    expect(humanizeVk(0xC0)).toBe('`');
    expect(humanizeVk(0xDC)).toBe('\\');
  });

  test('returns "Unknown" for unmapped vk', () => {
    expect(humanizeVk(0xFE)).toBe('Unknown');
    expect(humanizeVk(0)).toBe('Unknown');
    expect(humanizeVk(-1)).toBe('Unknown');
  });

  test('round-trip: every browser code resolves to a non-Unknown label', () => {
    // Sanity check that the reverse map is built correctly for every entry
    // in the forward map.
    const samples = ['KeyA', 'Digit5', 'F8', 'CapsLock', 'Insert', 'Space', 'Backquote'];
    for (const code of samples) {
      const vk = browserKeyToWin32Vk(code);
      expect(vk).not.toBeNull();
      expect(humanizeVk(vk!)).not.toBe('Unknown');
    }
  });
});
