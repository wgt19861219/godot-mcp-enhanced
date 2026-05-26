import { expect } from 'vitest';

import { clearGodotPathCache, getCachedGodotPath } from '../src/GodotServer.js';

describe('Godot path cache', () => {
  beforeEach(() => {
    clearGodotPathCache();
  });

  it('returns null before any findGodot call', () => {
    expect(getCachedGodotPath()).toBe(null);
  });

  it('clearGodotPathCache resets cache to null', () => {
    // Even if a test previously set the cache, clearing should yield null
    clearGodotPathCache();
    expect(getCachedGodotPath()).toBe(null);
  });

  it('getCachedGodotPath returns same value on repeated calls without clearing', () => {
    const first = getCachedGodotPath();
    const second = getCachedGodotPath();
    expect(first).toBe(second);
  });

  it('clearGodotPathCache is idempotent', () => {
    clearGodotPathCache();
    clearGodotPathCache();
    clearGodotPathCache();
    expect(getCachedGodotPath()).toBe(null);
  });
});
