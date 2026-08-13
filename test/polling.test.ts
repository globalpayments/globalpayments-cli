import { describe, it, expect } from 'vitest';
import { calculatePollingWindow, calculateNextPollTime } from '../src/core/polling.js';

/** Parse "YYYY-MM-DD HH:MM:SS" (UTC) to ms since epoch */
function parseGpDate(s: string): number {
  return new Date(s.replace(' ', 'T') + 'Z').getTime();
}

describe('calculatePollingWindow', () => {
  it('creates a window extending lookbackMinutes into the past from now', () => {
    const now = new Date('2025-01-01T12:00:00Z').getTime();
    const params = {
      lookbackMinutes: 5,
      overlapSeconds: 0,
      pageSize: 100,
      order: 'DESC' as const
    };

    const window = calculatePollingWindow(params, now);

    expect(parseGpDate(window.toTimeCreated)).toEqual(now);
    const fromTime = parseGpDate(window.fromTimeCreated);
    const expectedFromTime = now - 5 * 60 * 1000;
    expect(Math.abs(fromTime - expectedFromTime)).toBeLessThan(100);
  });

  it('includes overlapSeconds buffer in lookback window', () => {
    const now = new Date('2025-01-01T12:00:00Z').getTime();
    const params = {
      lookbackMinutes: 5,
      overlapSeconds: 30,
      pageSize: 100,
      order: 'DESC' as const
    };

    const window = calculatePollingWindow(params, now);

    const fromTime = parseGpDate(window.fromTimeCreated);
    const expectedFromTime = now - 5 * 60 * 1000 - 30 * 1000;
    expect(Math.abs(fromTime - expectedFromTime)).toBeLessThan(100);
  });

  it('preserves page size and order settings', () => {
    const params = {
      lookbackMinutes: 5,
      overlapSeconds: 0,
      pageSize: 50,
      order: 'ASC' as const
    };

    const window = calculatePollingWindow(params);

    expect(window.pageSize).toEqual(50);
    expect(window.order).toEqual('ASC');
    expect(window.page).toEqual(1);
  });

  it('returns GP API date format (YYYY-MM-DD HH:MM:SS)', () => {
    const params = {
      lookbackMinutes: 5,
      overlapSeconds: 0,
      pageSize: 100,
      order: 'DESC' as const
    };

    const window = calculatePollingWindow(params);

    // GP API format: "YYYY-MM-DD HH:MM:SS" — no T, no milliseconds, no Z
    const gpDatePattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
    expect(window.fromTimeCreated).toMatch(gpDatePattern);
    expect(window.toTimeCreated).toMatch(gpDatePattern);
  });

  it('handles zero overlap correctly', () => {
    const now = new Date('2025-01-01T12:00:00Z').getTime();
    const params = {
      lookbackMinutes: 10,
      overlapSeconds: 0,
      pageSize: 100,
      order: 'DESC' as const
    };

    const window = calculatePollingWindow(params, now);

    const fromTime = parseGpDate(window.fromTimeCreated);
    const expectedFromTime = now - 10 * 60 * 1000;
    expect(Math.abs(fromTime - expectedFromTime)).toBeLessThan(100);
  });

  it('defaults to current time when now is not provided', () => {
    const beforeCall = Date.now();
    const params = {
      lookbackMinutes: 5,
      overlapSeconds: 0,
      pageSize: 100,
      order: 'DESC' as const
    };

    const window = calculatePollingWindow(params);
    const afterCall = Date.now();

    const toTime = parseGpDate(window.toTimeCreated);
    // Allow up to 999ms rounding (seconds-level truncation by GP format)
    expect(toTime).toBeGreaterThanOrEqual(beforeCall - 999);
    expect(toTime).toBeLessThanOrEqual(afterCall);
  });
});

describe('calculateNextPollTime', () => {
  it('returns current time plus interval', () => {
    const now = 1000;
    const interval = 5000;

    const nextTime = calculateNextPollTime(interval, now);

    expect(nextTime).toEqual(6000);
  });

  it('defaults to current time when now is not provided', () => {
    const beforeCall = Date.now();
    const interval = 5000;

    const nextTime = calculateNextPollTime(interval);
    const afterCall = Date.now();

    expect(nextTime).toBeGreaterThanOrEqual(beforeCall + interval);
    expect(nextTime).toBeLessThanOrEqual(afterCall + interval);
  });
});
