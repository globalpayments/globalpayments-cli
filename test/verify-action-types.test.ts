import { describe, it, expect } from 'vitest';
import {
  applyObservedType,
  caseEndpoints,
  gpTime,
  placeholderPath,
  reconcile,
  verdictFor
} from '../scripts/verify-action-types.mjs';

const CASE = `id: incremental
name: "Increment an authorization — POST /transactions/{id}/incremental"
required: false
source: actions
observability: polling
tags:
  - transactions
  - action-type-inferred
mode: latest
# Action type inferred from GP naming conventions and not yet observed. If this case stays pending, see diagnose.
matcher:
  type: INCREMENTAL
  resource: TRANSACTIONS
expect:
  latest:
    responseCodeIn:
      - "200"
`;

describe('verify-action-types', () => {
  it('parses every endpoint variant from a case name', () => {
    expect(caseEndpoints('Close a batch — POST /batches/{id} or POST /batches')).toEqual([
      'POST /batches/{id}',
      'POST /batches'
    ]);
    expect(caseEndpoints('Sale with no endpoint')).toEqual([]);
  });

  it('fills path parameters with id-shaped placeholders', () => {
    expect(placeholderPath('/transactions/{id}/split')).toBe('/transactions/TRN_gpcliVerifyPlaceholder0000000/split');
    expect(placeholderPath('/merchants/{id}/orders/{ORD_id}')).toBe(
      '/merchants/MER_gpcliVerifyPlaceholder0000000/orders/ORD_gpcliVerifyPlaceholder0000000'
    );
  });

  it('reads zoneless GP timestamps as UTC', () => {
    expect(gpTime('2026-11-03T14:31:44.912')).toBe(Date.parse('2026-11-03T14:31:44.912Z'));
    expect(gpTime('2026-11-03 14:31:44')).toBe(Date.parse('2026-11-03T14:31:44Z'));
    expect(gpTime('2026-11-03T14:31:44.912Z')).toBe(Date.parse('2026-11-03T14:31:44.912Z'));
  });

  describe('reconcile', () => {
    it('pairs anchored calls by action id and the rest by time, using the measured clock offset', () => {
      // The local clock runs 10s behind GP.
      const offset = 10_000;
      const calls = [
        { seq: 0, status: 200, tStart: 1_000, tEnd: 1_200, responseActionId: 'ACT_a', responseActionType: 'AUTHORIZE' },
        { seq: 1, status: 404, tStart: 1_600, tEnd: 1_800 },
        { seq: 2, status: 403, tStart: 2_200, tEnd: 2_400 },
        { seq: 3, status: 200, tStart: 2_800, tEnd: 3_000, responseActionId: 'ACT_d', responseActionType: 'CAPTURE' }
      ];
      const at = (ms: number) => new Date(ms + offset).toISOString();
      const actions = [
        { id: 'ACT_a', type: 'AUTHORIZE', time_created: at(1_100), http_response_code: '200' },
        { id: 'ACT_b', type: 'TRANSACTION_SINGLE', time_created: at(1_700), http_response_code: '404' },
        { id: 'ACT_d', type: 'CAPTURE', time_created: at(2_900), http_response_code: '200' },
        { id: 'ACT_x', type: 'ACTION_LIST', time_created: at(2_300), http_response_code: '200' }
      ];

      const paired = reconcile(calls, actions);

      expect(paired.get(0)?.id).toBe('ACT_a');
      expect(paired.get(1)?.id).toBe('ACT_b');
      // Not logged by GP; ACTION_LIST in its window is the tool's own and must not be claimed.
      expect(paired.has(2)).toBe(false);
      expect(paired.get(3)?.id).toBe('ACT_d');
    });

    it('does not let one unlogged call shift every later pairing', () => {
      const calls = [
        { seq: 0, status: 502, tStart: 0, tEnd: 100 },
        { seq: 1, status: 403, tStart: 500, tEnd: 600 },
        { seq: 2, status: 404, tStart: 1_000, tEnd: 1_100 }
      ];
      const actions = [
        { id: 'ACT_1', type: 'CHALLENGE', time_created: new Date(550).toISOString(), http_response_code: '403' },
        { id: 'ACT_2', type: 'ADJUST', time_created: new Date(1_050).toISOString(), http_response_code: '404' }
      ];

      const paired = reconcile(calls, actions);

      expect(paired.has(0)).toBe(false);
      expect(paired.get(1)?.id).toBe('ACT_1');
      expect(paired.get(2)?.id).toBe('ACT_2');
    });
  });

  it('only treats a successful call as evidence', () => {
    expect(verdictFor('REVERSE', { type: 'REVERSE' }, 200)).toBe('confirmed');
    expect(verdictFor('INCREMENTAL', { type: 'INCREMENT' }, 200)).toBe('corrected');
    expect(verdictFor('SPLIT', { type: 'SPLIT' }, 403)).toBe('unverified');
    expect(verdictFor('HOLD', undefined, 200)).toBe('not-logged');
  });

  describe('applyObservedType', () => {
    it('rewrites the matcher type and evidence while keeping the rest of the file', () => {
      const out = applyObservedType(CASE, 'INCREMENT', '2026-11-02');

      expect(out).toContain('  type: INCREMENT\n  resource: TRANSACTIONS');
      expect(out).toContain('  - action-type-confirmed');
      expect(out).not.toContain('action-type-inferred');
      expect(out).toContain('# Action type confirmed in a GP sandbox action log (scripts/verify-action-types.mjs, 2026-11-02).');
      expect(out).toContain('required: false');
      expect(out).toContain('expect:\n  latest:');
    });

    it('downgrades a case to optional partial when its type is shared', () => {
      const required = CASE.replace('required: false', 'required: true');
      const out = applyObservedType(required, 'PAYMENT_METHOD_LIST', '2026-11-02', ['global-tokenization:payment-method-list']);

      expect(out).toContain('required: false');
      expect(out).toContain('observability: partial');
      expect(out).toContain('the same action type as global-tokenization:payment-method-list');
    });

    it('adds a type to a matcher that only had a resource', () => {
      const resourceOnly = CASE.replace('  type: INCREMENTAL\n', '');
      expect(applyObservedType(resourceOnly, 'DEVICE_SYNC', '2026-11-02')).toContain('matcher:\n  type: DEVICE_SYNC\n  resource: TRANSACTIONS');
    });
  });
});
