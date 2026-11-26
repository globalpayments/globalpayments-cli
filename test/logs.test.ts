import { describe, expect, it } from 'vitest';
import { parseStatusFilter, toLogEntry } from '../src/commands/logs.js';

describe('request log status filter', () => {
  it.each(['4xx', '5xx', '400', '599'])('accepts %s', (value) => {
    expect(parseStatusFilter(value)).toBe(value);
  });

  it.each(['099', '600', '4x', ''])('rejects %s', (value) => {
    expect(() => parseStatusFilter(value)).toThrow();
  });
});

describe('request log entries', () => {
  // Shape of a real sandbox /actions item: GP sent no response_message.
  const action = {
    id: 'ACT_uug2T0ywE32sS3AhUdT0Ugu49PzYzY',
    type: 'PAYMENT_METHOD_DETOKENIZE',
    time_created: '2026-11-23T19:11:07.368Z',
    resource: 'PAYMENT_METHODS',
    resource_id: 'PMT_afcfdca1-a0ea-46b9-ac9e-59887cb0f88e',
    http_response_code: '403',
    response_code: 'ACTION_NOT_AUTHORIZED'
  };

  it('does not repeat the response code as the message', () => {
    expect(toLogEntry(action)).toEqual({
      id: action.id,
      timeCreated: action.time_created,
      status: 403,
      type: 'PAYMENT_METHOD_DETOKENIZE',
      resource: 'PAYMENT_METHODS',
      resourceId: action.resource_id,
      responseCode: 'ACTION_NOT_AUTHORIZED'
    });
  });

  it('keeps a real response message', () => {
    expect(toLogEntry({ ...action, response_message: 'Merchant is not permitted' })?.message).toBe(
      'Merchant is not permitted'
    );
  });
});
