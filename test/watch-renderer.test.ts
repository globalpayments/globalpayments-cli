import { describe, expect, it } from 'vitest';
import { renderInteractiveWatchFrame } from '../src/io/watch-renderer.js';
import type { CaseRunState } from '../src/core/engine.js';
import type { CertificationCase } from '../src/types/domain.js';

const caze: CertificationCase = {
  id: 'global-core:sale-approved',
  name: 'Sale approved',
  scenario: 'Customer submits an approved sale.',
  required: true,
  matcher: {
    amount: 1000,
    currency: 'USD'
  },
  expect: {
    latest: {
      statusIn: ['CAPTURED']
    }
  }
};

const state: CaseRunState = {
  namespacedId: 'global-core:sale-approved',
  packId: 'global-core',
  caseId: 'global-core:sale-approved',
  status: 'pending',
  reason: 'No matching transactions found in current window',
  matchedCount: 0
};

const caseDefinitions = new Map([[state.namespacedId, caze]]);

describe('watch renderer', () => {
  it('renders wide terminals with expected tests and details columns', () => {
    const frame = renderInteractiveWatchFrame({
      cases: [state],
      caseDefinitions,
      columns: 120,
      rows: 24,
      selectedIndex: 0
    });

    expect(frame).toContain('Expected tests');
    expect(frame).toContain('Details');
    expect(frame).toContain('Scenario');
    expect(frame).toContain('Expected values');
  });

  it('renders narrow details as a drill-in view', () => {
    const frame = renderInteractiveWatchFrame({
      cases: [state],
      caseDefinitions,
      columns: 80,
      rows: 24,
      selectedIndex: 0,
      detailOpen: true,
      focus: 'details'
    });

    expect(frame).toContain('Details');
    expect(frame).toContain('Scenario');
    expect(frame).not.toContain('Expected tests');
  });
});
