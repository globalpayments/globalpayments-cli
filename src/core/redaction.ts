const REDACTED = '[REDACTED]';

const SECRET_KEYS = new Set([
  'secret',
  'appkey',
  'app_key',
  'token',
  'access_token',
  'authorization'
]);

function shouldRedactKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return SECRET_KEYS.has(normalized);
}

export function redactValue(key: string, value: unknown): unknown {
  if (shouldRedactKey(key)) {
    return REDACTED;
  }
  return value;
}

function redactUnknown(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map((item) => redactUnknown(item));
  }

  if (input && typeof input === 'object') {
    return redactObject(input as Record<string, unknown>);
  }

  return input;
}

export function redactObject(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (shouldRedactKey(key)) {
      out[key] = REDACTED;
      continue;
    }

    out[key] = redactUnknown(value);
  }

  return out;
}
