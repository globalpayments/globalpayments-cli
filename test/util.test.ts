import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import { parseDuration, formatDuration } from '../src/util/index.js';

describe('duration utilities', () => {
  describe('parseDuration', () => {
    it('parses milliseconds', () => {
      expect(parseDuration('1000')).toBe(1000);
      expect(parseDuration('500')).toBe(500);
    });

    it('parses seconds', () => {
      expect(parseDuration('10s')).toBe(10000);
      expect(parseDuration('1s')).toBe(1000);
      expect(parseDuration('0.5s')).toBe(500);
    });

    it('parses minutes', () => {
      expect(parseDuration('5m')).toBe(5 * 60 * 1000);
      expect(parseDuration('1m')).toBe(60 * 1000);
    });

    it('parses hours', () => {
      expect(parseDuration('1h')).toBe(60 * 60 * 1000);
      expect(parseDuration('2h')).toBe(2 * 60 * 60 * 1000);
    });

    it('throws on invalid duration', () => {
      expect(() => parseDuration('invalid')).toThrow();
      expect(() => parseDuration('x10s')).toThrow();
    });
  });

  describe('formatDuration', () => {
    it('formats milliseconds', () => {
      expect(formatDuration(500)).toBe('500ms');
    });

    it('formats seconds', () => {
      expect(formatDuration(1000)).toBe('1.0s');
      expect(formatDuration(5500)).toBe('5.5s');
    });

    it('formats minutes', () => {
      expect(formatDuration(60000)).toBe('1.0m');
      expect(formatDuration(300000)).toBe('5.0m');
    });

    it('formats hours', () => {
      expect(formatDuration(3600000)).toBe('1.0h');
      expect(formatDuration(7200000)).toBe('2.0h');
    });
  });
});
