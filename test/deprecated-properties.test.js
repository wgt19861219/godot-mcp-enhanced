import { describe, it, expect } from 'vitest';
import { DEPRECATED_PROPERTIES } from '../src/tools/deprecated-properties.js';

describe('DEPRECATED_PROPERTIES', () => {
  it('is non-empty object', () => {
    expect(typeof DEPRECATED_PROPERTIES).toBe('object');
    expect(Object.keys(DEPRECATED_PROPERTIES).length).toBeGreaterThan(0);
  });

  it('each entry has required fields', () => {
    for (const [className, props] of Object.entries(DEPRECATED_PROPERTIES)) {
      expect(typeof className).toBe('string');
      expect(className.length).toBeGreaterThan(0);
      for (const [propName, info] of Object.entries(props)) {
        expect(typeof propName).toBe('string');
        expect(typeof info.removed).toBe('boolean');
        // replacement is optional but must be string when present
        if (info.replacement !== undefined) {
          expect(typeof info.replacement).toBe('string');
        }
        // lintRule is optional but must be string when present
        if (info.lintRule !== undefined) {
          expect(typeof info.lintRule).toBe('string');
        }
      }
    }
  });

  it('replacement is not empty string when present', () => {
    for (const props of Object.values(DEPRECATED_PROPERTIES)) {
      for (const info of Object.values(props)) {
        if (info.replacement !== undefined) {
          expect(info.replacement.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('known deprecated property exists', () => {
    // Environment.adjustments_enabled is a known deprecated property
    expect(DEPRECATED_PROPERTIES['Environment']).toBeDefined();
    expect(DEPRECATED_PROPERTIES['Environment']['adjustments_enabled']).toBeDefined();
    expect(DEPRECATED_PROPERTIES['Environment']['adjustments_enabled'].replacement).toBe('adjustment_enabled');
    expect(DEPRECATED_PROPERTIES['Environment']['adjustments_enabled'].removed).toBe(false);
  });

  it('RigidBody3D bounce is marked removed', () => {
    expect(DEPRECATED_PROPERTIES['RigidBody3D']).toBeDefined();
    expect(DEPRECATED_PROPERTIES['RigidBody3D']['bounce']).toBeDefined();
    expect(DEPRECATED_PROPERTIES['RigidBody3D']['bounce'].removed).toBe(true);
  });

  it('all classes are valid Godot class names', () => {
    const classNames = Object.keys(DEPRECATED_PROPERTIES);
    for (const name of classNames) {
      // Class names should be PascalCase (no spaces, no special chars)
      expect(name).toMatch(/^[A-Z][a-zA-Z0-9]+$/);
    }
  });
});
