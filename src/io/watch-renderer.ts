import pc from 'picocolors';
import type { CertificationCase, TransactionRecord } from '../types/domain.js';
import type { CaseRunState } from '../core/engine.js';
import { buildCaseDetail, type CaseDetail, type DetailComparisonRow, type DetailValueRow } from './case-details.js';

const WIDE_LAYOUT_MIN_COLUMNS = 100;
const LIST_MIN_COLUMNS = 36;
const PANE_GAP = 3;

export interface WatchFrameInput {
  cycleNumber?: number;
  transactionsFetched?: number;
  cases: CaseRunState[];
  recentTransactions?: TransactionRecord[];
  caseDefinitions: Map<string, CertificationCase>;
  selectedIndex?: number;
  focus?: 'list' | 'details';
  detailScrollOffset?: number;
  columns?: number;
  rows?: number;
  detailOpen?: boolean;
}

function visibleLength(input: string): number {
  return input.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').length;
}

function truncate(input: string, width: number): string {
  if (width <= 0) {
    return '';
  }
  const length = visibleLength(input);
  if (length <= width) {
    return input;
  }

  const plain = input.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
  return width === 1 ? '…' : `${plain.slice(0, width - 1)}…`;
}

function padRight(input: string, width: number): string {
  const clipped = truncate(input, width);
  return clipped + ' '.repeat(Math.max(0, width - visibleLength(clipped)));
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  if (value === undefined) {
    return '(missing)';
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

function renderCaseLine(state: CaseRunState, selected: boolean): string {
  const icon = state.status === 'pass' ? pc.green('✓') : state.status === 'fail' ? pc.red('✗') : pc.gray('○');
  const status = state.status === 'pass' ? pc.green('PASS') : state.status === 'fail' ? pc.red('FAIL') : pc.gray('PEND');
  const cursor = selected ? pc.cyan('>') : ' ';
  const reason = state.status !== 'pass' ? pc.gray(` — ${state.reason}`) : '';
  return `${cursor} ${icon} ${state.namespacedId} [${status}]${reason}`;
}

function renderRecentTransaction(txn: TransactionRecord): string {
  const time = txn.timeCreated ? new Date(txn.timeCreated).toLocaleTimeString() : '?';
  const amount = txn.amount !== undefined ? `${txn.amount} ${txn.currency ?? ''}`.trim() : '';
  const cardBrand = txn.cardBrand ?? txn.paymentMethod?.cardBrand;
  const last4 = txn.last4 ?? txn.paymentMethod?.last4;
  const card = cardBrand ? `${cardBrand}${last4 ? ` ····${last4}` : ''}` : '';
  const parts = [
    pc.gray(time),
    txn.type ? pc.cyan(txn.type) : '',
    txn.status ? pc.white(txn.status) : '',
    amount ? pc.yellow(amount) : '',
    card ? pc.gray(card) : '',
    txn.responseCode ? pc.gray(`[${txn.responseCode}]`) : ''
  ].filter(Boolean);
  return `  ${parts.join('  ')}`;
}

function renderValueRows(rows: DetailValueRow[]): string[] {
  if (rows.length === 0) {
    return [pc.gray('  No expected values configured.')];
  }
  return rows.map((row) => `  ${pc.cyan(row.label)}: ${formatValue(row.value)}`);
}

function renderComparisonRow(row: DetailComparisonRow): string {
  const marker = row.status === 'matched' ? pc.green('✓') : row.status === 'changed' ? pc.red('✗') : pc.yellow('!');
  return `  ${marker} ${pc.cyan(row.label)}: ${formatValue(row.expected)} ${pc.gray('vs')} ${formatValue(row.actual)}`;
}

function renderDetail(detail: CaseDetail): string[] {
  const lines: string[] = [];
  const status = detail.status === 'pass' ? pc.green('Pass') : detail.status === 'fail' ? pc.red('Failed') : pc.gray('Pending');
  lines.push(pc.bold(detail.name));
  lines.push(`${pc.gray('Case:')} ${detail.id}`);
  lines.push(`${pc.gray('Status:')} ${status}`);
  if (detail.reason) {
    lines.push(`${pc.gray('Reason:')} ${detail.reason}`);
  }
  if (detail.diagnosisCode) {
    lines.push(`${pc.gray('Cause:')} ${pc.magenta(detail.diagnosisCode)}`);
  }
  lines.push('');
  lines.push(pc.bold('Scenario'));
  lines.push(`  ${detail.scenario}`);
  lines.push('');

  // The remedy comes before the evidence: someone watching a red case wants the
  // change to make, not a field table to interpret first.
  if (detail.fixes.length > 0) {
    lines.push(pc.bold(pc.yellow('To turn this green')));
    detail.fixes.forEach((fix, index) => {
      lines.push(`  ${index + 1}. ${fix}`);
    });
    lines.push('');
  }

  if (detail.status === 'fail') {
    lines.push(pc.bold('What we expected'));
    lines.push(...renderValueRows(detail.expectedValues));
    lines.push('');
    lines.push(pc.bold('What you sent'));
    if (detail.sentValues.length === 0) {
      lines.push(pc.gray('  No submitted payload was captured for this test.'));
    } else {
      lines.push(...detail.sentValues.map((row) => `  ${pc.cyan(row.label)}: ${formatValue(row.value)}`));
    }
    if (detail.comparisons.length > 0) {
      lines.push('');
      lines.push(pc.bold('Comparison'));
      lines.push(...detail.comparisons.map(renderComparisonRow));
    }
  } else {
    lines.push(pc.bold('Expected values'));
    lines.push(...renderValueRows(detail.expectedValues));
  }

  return lines;
}

function summaryLine(cases: CaseRunState[]): string {
  const passCount = cases.filter((c) => c.status === 'pass').length;
  const failCount = cases.filter((c) => c.status === 'fail').length;
  const pendCount = cases.filter((c) => c.status === 'pending').length;
  return `Summary: ${pc.green(`${passCount} pass`)}, ${pc.red(`${failCount} fail`)}, ${pc.gray(`${pendCount} pending`)}`;
}

function detailFor(input: WatchFrameInput, selected: CaseRunState | undefined): CaseDetail | undefined {
  if (!selected) {
    return undefined;
  }
  const caze = input.caseDefinitions.get(selected.namespacedId);
  return caze ? buildCaseDetail(caze, selected) : undefined;
}

function clipLines(lines: string[], maxLines: number, offset = 0): string[] {
  if (maxLines <= 0) {
    return [];
  }
  return lines.slice(offset, offset + maxLines);
}

function renderListPane(input: WatchFrameInput, width: number, height?: number): string[] {
  const selectedIndex = input.selectedIndex ?? 0;
  const lines: string[] = [];
  lines.push(pc.bold('Expected tests'));
  if (input.cycleNumber !== undefined && input.transactionsFetched !== undefined) {
    lines.push(pc.gray(`Cycle ${input.cycleNumber} · ${input.transactionsFetched} transaction(s) fetched`));
  }
  lines.push(pc.gray('─'.repeat(Math.max(0, width))));
  for (const [index, state] of input.cases.entries()) {
    lines.push(renderCaseLine(state, index === selectedIndex));
  }
  lines.push('');
  lines.push(summaryLine(input.cases));
  lines.push(pc.gray('↑/↓ move • enter/i details • q quit'));

  const maxLines = height ?? lines.length;
  return clipLines(lines, maxLines);
}

function renderDetailPane(input: WatchFrameInput, width: number, height?: number): string[] {
  const selected = input.cases[input.selectedIndex ?? 0];
  const detail = detailFor(input, selected);
  const lines = [pc.bold('Details'), pc.gray('─'.repeat(Math.max(0, width)))];
  if (!detail) {
    lines.push(pc.gray('Select a test to view details.'));
  } else {
    lines.push(...renderDetail(detail));
  }

  const maxLines = height ?? lines.length;
  const body = lines.slice(2);
  const visibleBodyLines = Math.max(0, maxLines - 2);
  const maxOffset = Math.max(0, body.length - visibleBodyLines);
  const offset = input.focus === 'details' ? Math.min(input.detailScrollOffset ?? 0, maxOffset) : 0;
  const clippedBody = clipLines(body, visibleBodyLines, offset);
  const output = [lines[0]!, lines[1]!, ...clippedBody];
  if (offset + clippedBody.length < body.length && output.length > 0) {
    output[output.length - 1] = pc.gray('↓ more');
  }
  return output;
}

export function renderClassicWatchFrame(input: WatchFrameInput): string {
  const lines: string[] = [];
  if (input.cycleNumber !== undefined && input.transactionsFetched !== undefined) {
    lines.push(`${pc.gray(`[Cycle ${input.cycleNumber}]`)} ${input.transactionsFetched} transaction(s) fetched`);
    if (input.transactionsFetched === 0) {
      lines.push(pc.yellow('  No transactions found in this polling window.'));
    }
    lines.push('');
  }

  for (const state of input.cases) {
    lines.push(renderCaseLine(state, false).replace(/^  /, '  '));
  }
  lines.push('');
  lines.push(summaryLine(input.cases));

  if (input.recentTransactions && input.recentTransactions.length > 0) {
    lines.push('');
    lines.push(pc.gray('Recent transactions:'));
    for (const txn of input.recentTransactions) {
      lines.push(renderRecentTransaction(txn));
    }
  }

  return `${lines.join('\n')}\n`;
}

export function renderInteractiveWatchFrame(input: WatchFrameInput): string {
  const columns = input.columns ?? 80;
  const rows = input.rows ?? 24;
  const wide = columns >= WIDE_LAYOUT_MIN_COLUMNS;

  if (!wide && input.detailOpen) {
    const detailLines = renderDetailPane(input, columns, rows - 1).map((line) => truncate(line, columns));
    return `${detailLines.join('\n')}\n${pc.gray('esc/q back • ↑/↓ scroll')}`;
  }

  if (!wide) {
    return renderListPane(input, columns, rows).map((line) => truncate(line, columns)).join('\n');
  }

  const listWidth = Math.max(LIST_MIN_COLUMNS, Math.floor(columns * 0.42));
  const detailWidth = Math.max(20, columns - listWidth - PANE_GAP);
  const height = rows;
  const left = renderListPane(input, listWidth, height);
  const right = renderDetailPane(input, detailWidth, height);
  const lineCount = Math.max(left.length, right.length);
  const lines: string[] = [];

  for (let index = 0; index < lineCount; index += 1) {
    const leftLine = padRight(left[index] ?? '', listWidth);
    const rightLine = truncate(right[index] ?? '', detailWidth);
    lines.push(`${leftLine}${' '.repeat(PANE_GAP)}${rightLine}`);
  }

  return lines.join('\n');
}
