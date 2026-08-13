import type { PollWindow, PollOrder } from '../types/domain.js';

/**
 * Format a Date as "YYYY-MM-DD HH:MM:SS" (UTC) per GP API requirements.
 * The API rejects ISO 8601 format (with T, milliseconds, and Z suffix).
 */
function toGpDateString(date: Date): string {
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

export interface PollingParams {
  lookbackMinutes: number;
  overlapSeconds: number;
  pageSize: number;
  order: PollOrder;
}

/**
 * Calculate the polling window for transaction queries.
 *
 * The window extends from (now - lookbackMinutes) to now, with an overlap
 * buffer on the lower bound to catch transactions that might have been
 * missed due to clock skew or processing delay.
 *
 * @param params - polling configuration
 * @param now - current time (defaults to Date.now())
 * @returns PollWindow for use with GP API transaction queries
 */
export function calculatePollingWindow(params: PollingParams, now: number = Date.now()): PollWindow {
  const nowDate = new Date(now);
  const fromDate = new Date(now - params.lookbackMinutes * 60 * 1000 - params.overlapSeconds * 1000);

  return {
    fromTimeCreated: toGpDateString(fromDate),
    toTimeCreated: toGpDateString(nowDate),
    pageSize: params.pageSize,
    order: params.order,
    page: 1
  };
}

/**
 * Calculate the next polling interval time.
 * Useful for scheduling the next poll.
 *
 * @param intervalMs - interval in milliseconds
 * @returns Unix timestamp in milliseconds for the next poll
 */
export function calculateNextPollTime(intervalMs: number, now: number = Date.now()): number {
  return now + intervalMs;
}
