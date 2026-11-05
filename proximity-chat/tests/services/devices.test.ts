import { listAudioDevices } from '../../src/services/devices';

// jsdom is not the default environment; we stub navigator + localStorage just
// enough for the devices module to exercise its filter logic.
const enumerateDevicesMock = jest.fn();
(globalThis as any).navigator = {
  mediaDevices: {
    enumerateDevices: enumerateDevicesMock,
    getUserMedia: jest.fn(),
  },
};
(globalThis as any).localStorage = {
  store: {} as Record<string, string>,
  getItem(key: string) { return this.store[key] ?? null; },
  setItem(key: string, value: string) { this.store[key] = value; },
  removeItem(key: string) { delete this.store[key]; },
};

describe('listAudioDevices', () => {
  beforeEach(() => {
    enumerateDevicesMock.mockReset();
  });

  test('separates audioinput and audiooutput devices', async () => {
    enumerateDevicesMock.mockResolvedValue([
      { kind: 'audioinput', deviceId: 'mic1', label: 'Mic One', groupId: '' },
      { kind: 'audiooutput', deviceId: 'spk1', label: 'Speaker One', groupId: '' },
      { kind: 'videoinput', deviceId: 'cam1', label: 'Camera', groupId: '' },
    ]);
    const result = await listAudioDevices();
    expect(result.inputs).toHaveLength(1);
    expect(result.outputs).toHaveLength(1);
    expect(result.inputs[0].deviceId).toBe('mic1');
    expect(result.outputs[0].deviceId).toBe('spk1');
  });

  test('drops synthetic "default" entries that duplicate real devices', async () => {
    enumerateDevicesMock.mockResolvedValue([
      { kind: 'audioinput', deviceId: 'default', label: 'Default - Mic One', groupId: '' },
      { kind: 'audioinput', deviceId: 'mic1-real-id', label: 'Mic One', groupId: '' },
      { kind: 'audiooutput', deviceId: 'default', label: 'Default - Speaker', groupId: '' },
      { kind: 'audiooutput', deviceId: 'spk1-real-id', label: 'Speaker', groupId: '' },
    ]);
    const result = await listAudioDevices();
    expect(result.inputs.every((d) => d.deviceId !== 'default')).toBe(true);
    expect(result.outputs.every((d) => d.deviceId !== 'default')).toBe(true);
    expect(result.inputs.map((d) => d.deviceId)).toEqual(['mic1-real-id']);
    expect(result.outputs.map((d) => d.deviceId)).toEqual(['spk1-real-id']);
  });

  test('drops synthetic "communications" entries (Windows-only)', async () => {
    enumerateDevicesMock.mockResolvedValue([
      { kind: 'audioinput', deviceId: 'communications', label: 'Communications - Mic', groupId: '' },
      { kind: 'audioinput', deviceId: 'real-mic', label: 'Real Mic', groupId: '' },
    ]);
    const result = await listAudioDevices();
    expect(result.inputs.map((d) => d.deviceId)).toEqual(['real-mic']);
  });

  test('empty enumerate result returns empty arrays (no crash)', async () => {
    enumerateDevicesMock.mockResolvedValue([]);
    const result = await listAudioDevices();
    expect(result.inputs).toEqual([]);
    expect(result.outputs).toEqual([]);
  });
});
