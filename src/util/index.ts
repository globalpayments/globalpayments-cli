export function identity<T>(value: T): T {
  return value;
}

/**
 * Parse a duration string into milliseconds.
 * Supports: "10s", "5m", "1h", "30"
 */
export function parseDuration(input: string): number {
  const trimmed = input.trim();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)(s|ms|m|h)$/);

  if (!match) {
    // Treat as milliseconds if no unit
    const num = Number(trimmed);
    if (isNaN(num)) {
      throw new Error(`Invalid duration: ${input}. Use "10s", "5m", "1h", or milliseconds.`);
    }
    return num;
  }

  const value = parseFloat(match[1] ?? '0');
  const unit = match[2] ?? 'ms';

  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000
  };

  return Math.round(value * (multipliers[unit] ?? 1));
}

/**
 * Format milliseconds into a human-readable duration.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60 * 1000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  if (ms < 60 * 60 * 1000) {
    return `${(ms / (60 * 1000)).toFixed(1)}m`;
  }
  return `${(ms / (60 * 60 * 1000)).toFixed(1)}h`;
}
