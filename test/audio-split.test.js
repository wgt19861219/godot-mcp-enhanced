import { expect } from 'vitest';
import {
  TOOL_NAMES,
  getToolDefinitions,
  genAudioPlayScript,
  genAudioStopScript,
  genAudioSetParamScript,
  genAudioQueryScript,
} from '../src/tools/audio-ops.js';

// ─── TOOL_NAMES ─────────────────────────────────────────────────────────────

describe('audio-ops TOOL_NAMES', () => {
  it('contains exactly 4 tool names', () => {
    expect(TOOL_NAMES.length).toBe(4);
  });
  it('includes audio_play', () => {
    expect(TOOL_NAMES.includes('audio_play')).toBeTruthy();
  });
  it('includes audio_stop', () => {
    expect(TOOL_NAMES.includes('audio_stop')).toBeTruthy();
  });
  it('includes audio_set_param', () => {
    expect(TOOL_NAMES.includes('audio_set_param')).toBeTruthy();
  });
  it('includes audio_query', () => {
    expect(TOOL_NAMES.includes('audio_query')).toBeTruthy();
  });
});

// ─── getToolDefinitions ─────────────────────────────────────────────────────

describe('audio-ops getToolDefinitions', () => {
  it('returns 4 tool definitions', () => {
    const defs = getToolDefinitions();
    expect(defs.length).toBe(4);
  });
  it('each definition has a name from TOOL_NAMES', () => {
    const defs = getToolDefinitions();
    const names = defs.map(d => d.name);
    for (const tn of TOOL_NAMES) {
      expect(names.includes(tn)).toBeTruthy();
    }
  });
});

// ─── genAudioPlayScript ─────────────────────────────────────────────────────

describe('genAudioPlayScript', () => {
  it('generates play script with stream_path', () => {
    const script = genAudioPlayScript('/root/BGMPlayer', 'res://audio/bgm.ogg', -10, 1.0, 'Master');
    expect(script.includes('get_node("/root/BGMPlayer")')).toBeTruthy();
    expect(script.includes('res://audio/bgm.ogg')).toBeTruthy();
    expect(script.includes('volume_db = -10')).toBeTruthy();
    expect(script.includes('pitch_scale = 1.0')).toBeTruthy();
    expect(script.includes('AudioStreamPlayer')).toBeTruthy();
    expect(script.includes('.play()')).toBeTruthy();
  });
  it('generates play script without stream_path', () => {
    const script = genAudioPlayScript('/root/SFX');
    expect(script.includes('.play()')).toBeTruthy();
    expect(script.includes('node.stream =')).toBeFalsy();
  });
  it('generates play script with from_position', () => {
    const script = genAudioPlayScript('/root/BGM', undefined, undefined, undefined, undefined, 5.0);
    expect(script.includes('.play(5.0)')).toBeTruthy();
  });
});

// ─── genAudioStopScript ─────────────────────────────────────────────────────

describe('genAudioStopScript', () => {
  it('generates stop script', () => {
    const script = genAudioStopScript('/root/BGMPlayer');
    expect(script.includes('get_node("/root/BGMPlayer")')).toBeTruthy();
    expect(script.includes('.stop()')).toBeTruthy();
  });
});

// ─── genAudioSetParamScript ─────────────────────────────────────────────────

describe('genAudioSetParamScript', () => {
  it('generates volume_db param script', () => {
    const script = genAudioSetParamScript('/root/BGM', 'volume_db', -5);
    expect(script.includes('volume_db = -5')).toBeTruthy();
  });
  it('generates pitch_scale param script', () => {
    const script = genAudioSetParamScript('/root/BGM', 'pitch_scale', 1.5);
    expect(script.includes('pitch_scale = 1.5')).toBeTruthy();
  });
  it('generates bus param script', () => {
    const script = genAudioSetParamScript('/root/BGM', 'bus', 'SFX');
    expect(script.includes('bus = "SFX"')).toBeTruthy();
  });
});

// ─── genAudioQueryScript ────────────────────────────────────────────────────

describe('genAudioQueryScript', () => {
  it('generates query script', () => {
    const script = genAudioQueryScript('/root/BGM');
    expect(script.includes('get_node("/root/BGM")')).toBeTruthy();
    expect(script.includes('playing')).toBeTruthy();
    expect(script.includes('volume_db')).toBeTruthy();
    expect(script.includes('pitch_scale')).toBeTruthy();
    expect(script.includes('bus')).toBeTruthy();
    expect(script.includes('get_playback_position')).toBeTruthy();
  });
});
