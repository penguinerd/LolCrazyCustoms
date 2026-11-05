import {
  MAX_NAME_CHARS,
  SPEAKING_HOLD_MS,
  SpeakingTracker,
  speakerLabel,
  speakerName,
} from '../../src/services/speakers';

const T = 0.02;
const levels = (o: Record<string, number>): Map<string, number> => new Map(Object.entries(o));

describe('speaker labels', () => {
  it('shows "Summoner (Champion)", without the Riot tag', () => {
    expect(speakerLabel('Quevedo#cpev', 'Tristana')).toBe('Quevedo (Tristana)');
    expect(speakerLabel('treadmill lover#ayuda', 'Fiora')).toBe('treadmill lover (Fiora)');
  });

  it('cuts a long summoner name, never the champion', () => {
    const name = speakerName('PELILLOENRREDAODELMONTE#DEV');
    expect(name.length).toBe(MAX_NAME_CHARS);
    expect(name.endsWith('…')).toBe(true);
    expect(speakerLabel('PELILLOENRREDAODELMONTE#DEV', 'Maokai')).toBe(name + ' (Maokai)');
  });

  it('copes with no tag and no champion', () => {
    expect(speakerLabel('Someone', '')).toBe('Someone');
  });
});

describe('SpeakingTracker', () => {
  it('shows a player while their voice is above the level', () => {
    const s = new SpeakingTracker();
    expect(s.update(levels({ a: 0.1, b: 0.001 }), () => T, 0)).toEqual(['a']);
  });

  it('keeps them through a short pause between words, then drops them', () => {
    const s = new SpeakingTracker();
    s.update(levels({ a: 0.1 }), () => T, 0);
    expect(s.update(levels({ a: 0 }), () => T, SPEAKING_HOLD_MS - 100)).toEqual(['a']);
    expect(s.update(levels({ a: 0 }), () => T, SPEAKING_HOLD_MS + 1)).toEqual([]);
  });

  it('drops a player at once when we stop hearing them (out of the camera, muted)', () => {
    const s = new SpeakingTracker();
    s.update(levels({ a: 0.1 }), () => T, 0);
    expect(s.update(levels({}), () => T, 100)).toEqual([]);
  });

  it('keeps the order people started speaking in', () => {
    const s = new SpeakingTracker();
    s.update(levels({ b: 0.1, a: 0 }), () => T, 0);
    expect(s.update(levels({ a: 0.1, b: 0.1 }), () => T, 100)).toEqual(['b', 'a']);
  });

  it('uses each key\'s own threshold (our mic is measured differently)', () => {
    const s = new SpeakingTracker();
    const th = (k: string): number => (k === 'self' ? 0.012 : T);
    expect(s.update(levels({ self: 0.015, a: 0.015 }), th, 0)).toEqual(['self']);
  });
});
