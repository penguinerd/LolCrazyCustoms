import {
  getAllyProximity, setAllyProximity, getCameraListen, setCameraListen, getSharedReset, setSharedReset,
  getCameraOnly, setCameraOnly, getAppAudio, setAppAudio, applyAudioDefaultsOnce,
} from '../../src/services/audio-prefs';
import { getForceTurnRelay, setForceTurnRelay } from '../../src/services/privacy';

// The node test environment has no localStorage; a plain map is all the
// module touches.
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, value); },
  removeItem: (key: string) => { store.delete(key); },
};

describe('audio prefs', () => {
  beforeEach(() => store.clear());

  test('every panel toggle is on for a fresh install', () => {
    expect(getAllyProximity()).toBe(true);
    expect(getCameraListen()).toBe(true);
    expect(getCameraOnly()).toBe(true);
    expect(getSharedReset()).toBe(true);
    expect(getAppAudio()).toBe(true);
    expect(getForceTurnRelay()).toBe(true);
  });

  test('turning one off survives a restart, and does not touch the other', () => {
    setAllyProximity(false);
    expect(store.get('lolproxchat.allyProximity')).toBe('0');
    expect(getAllyProximity()).toBe(false);
    expect(getCameraListen()).toBe(true);

    setCameraListen(false);
    expect(getCameraListen()).toBe(false);
    setCameraListen(true);
    expect(getCameraListen()).toBe(true);
    expect(getAllyProximity()).toBe(false);
  });

  test('the first launch of this build puts every toggle back on, once', () => {
    setAllyProximity(false);
    setCameraListen(false);
    setCameraOnly(false);
    setSharedReset(false);
    setAppAudio(false);
    setForceTurnRelay(false);
    expect(applyAudioDefaultsOnce()).toBe(true);
    expect(getAllyProximity()).toBe(true);
    expect(getCameraListen()).toBe(true);
    expect(getCameraOnly()).toBe(true);
    expect(getSharedReset()).toBe(true);
    expect(getAppAudio()).toBe(true);
    expect(getForceTurnRelay()).toBe(true);

    // Turned off again afterwards, it stays off across later launches.
    setAllyProximity(false);
    expect(applyAudioDefaultsOnce()).toBe(false);
    expect(getAllyProximity()).toBe(false);
  });

  test('the one-time defaults never throw when storage does', () => {
    const real = (globalThis as any).localStorage;
    (globalThis as any).localStorage = { getItem: () => { throw new Error('denied'); } };
    try {
      expect(applyAudioDefaultsOnce()).toBe(false);
    } finally {
      (globalThis as any).localStorage = real;
    }
  });

  test('an install that had turned a toggle on before v0.5.18 keeps it on', () => {
    store.set('lolproxchat.allyProximity', '1');
    store.set('lolproxchat.cameraListen', '1');
    expect(getAllyProximity()).toBe(true);
    expect(getCameraListen()).toBe(true);
  });

  test('shared RESET, app audio and hide IP stay off once turned off', () => {
    setSharedReset(false);
    setAppAudio(false);
    setForceTurnRelay(false);
    expect(store.get('lolproxchat.sharedReset')).toBe('0');
    expect(store.get('lolproxchat.forceTurnRelay')).toBe('0');
    expect(getSharedReset()).toBe(false);
    expect(getAppAudio()).toBe(false);
    expect(getForceTurnRelay()).toBe(false);
    setSharedReset(true);
    expect(getSharedReset()).toBe(true);
  });

  test('the toggles read as on when storage cannot be read', () => {
    const real = (globalThis as any).localStorage;
    (globalThis as any).localStorage = { getItem: () => { throw new Error('blocked'); } };
    try {
      expect(getSharedReset()).toBe(true);
      expect(getAppAudio()).toBe(true);
      expect(getForceTurnRelay()).toBe(true);
    } finally {
      (globalThis as any).localStorage = real;
    }
  });
});
