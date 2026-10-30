import { describe, expect, it } from 'vitest';
import { isLevelEnabled, noopLogger } from './logger';

describe('isLevelEnabled', () => {
  it('enables levels at or below the threshold', () => {
    expect(isLevelEnabled('info', 'error')).toBe(true);
    expect(isLevelEnabled('info', 'warn')).toBe(true);
    expect(isLevelEnabled('info', 'info')).toBe(true);
  });

  it('disables more verbose levels than the threshold', () => {
    expect(isLevelEnabled('info', 'debug')).toBe(false);
    expect(isLevelEnabled('info', 'trace')).toBe(false);
    expect(isLevelEnabled('error', 'warn')).toBe(false);
  });

  it('trace threshold enables everything', () => {
    expect(isLevelEnabled('trace', 'trace')).toBe(true);
    expect(isLevelEnabled('trace', 'error')).toBe(true);
  });
});

describe('noopLogger', () => {
  it('accepts all levels without throwing', () => {
    expect(() => {
      noopLogger.error(new Error('x'));
      noopLogger.warn('w');
      noopLogger.info('i');
      noopLogger.debug('d');
      noopLogger.trace('t', { a: 1 });
    }).not.toThrow();
  });
});
