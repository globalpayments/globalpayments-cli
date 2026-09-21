import { clearScreenDown, cursorTo, emitKeypressEvents } from 'node:readline';
import type { ReadStream, WriteStream } from 'node:tty';
import type { CertificationCase, TransactionRecord } from '../types/domain.js';
import type { CaseRunState } from '../core/engine.js';
import { renderInteractiveWatchFrame } from './watch-renderer.js';

export interface InteractiveWatchControllerOptions {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  caseDefinitions: Map<string, CertificationCase>;
  abortController: AbortController;
}

export interface InteractiveWatchUpdate {
  cycleNumber?: number;
  transactionsFetched?: number;
  cases: CaseRunState[];
  recentTransactions?: TransactionRecord[];
}

export class InteractiveWatchController {
  private cases: CaseRunState[] = [];
  private recentTransactions: TransactionRecord[] = [];
  private cycleNumber: number | undefined;
  private transactionsFetched: number | undefined;
  private selectedIndex = 0;
  private focus: 'list' | 'details' = 'list';
  private detailOpen = false;
  private detailScrollOffset = 0;
  private readonly stdin: NodeJS.ReadStream;
  private readonly stdout: NodeJS.WriteStream;
  private readonly ttyStdin: ReadStream | undefined;
  private readonly ttyStdout: WriteStream | undefined;
  private readonly caseDefinitions: Map<string, CertificationCase>;
  private readonly abortController: AbortController;
  private readonly onKeypressBound = this.onKeypress.bind(this);
  private readonly onResizeBound = this.render.bind(this);

  constructor(options: InteractiveWatchControllerOptions) {
    this.stdin = options.stdin;
    this.stdout = options.stdout;
    this.ttyStdin = options.stdin.isTTY ? options.stdin as ReadStream : undefined;
    this.ttyStdout = options.stdout.isTTY ? options.stdout as WriteStream : undefined;
    this.caseDefinitions = options.caseDefinitions;
    this.abortController = options.abortController;
  }

  start(initialCases: CaseRunState[]): void {
    this.cases = initialCases;
    emitKeypressEvents(this.stdin);
    this.ttyStdin?.setRawMode(true);
    this.stdin.resume();
    this.stdin.on('keypress', this.onKeypressBound);
    this.stdout.on('resize', this.onResizeBound);
    this.stdout.write('\x1B[?25l');
    this.render();
  }

  update(update: InteractiveWatchUpdate): void {
    this.cycleNumber = update.cycleNumber;
    this.transactionsFetched = update.transactionsFetched;
    this.cases = update.cases;
    this.recentTransactions = update.recentTransactions ?? [];
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.cases.length - 1));
    this.render();
  }

  stop(): void {
    this.stdin.off('keypress', this.onKeypressBound);
    this.stdout.off('resize', this.onResizeBound);
    this.ttyStdin?.setRawMode(false);
    this.stdin.pause();
    this.stdout.write('\x1B[?25h');
  }

  private onKeypress(str: string, key: { name?: string; ctrl?: boolean }): void {
    if (key.ctrl && key.name === 'c') {
      this.abortController.abort();
      return;
    }

    const columns = this.ttyStdout?.columns ?? 80;
    const wide = columns >= 100;
    const name = key.name ?? str;

    if (name === 'q') {
      if (!wide && this.detailOpen) {
        this.detailOpen = false;
        this.focus = 'list';
      } else {
        this.abortController.abort();
      }
      this.render();
      return;
    }

    if (name === 'escape') {
      this.detailOpen = false;
      this.focus = 'list';
      this.render();
      return;
    }

    if (name === 'return' || name === 'space' || name === 'i') {
      if (wide) {
        this.focus = this.focus === 'details' ? 'list' : 'details';
      } else {
        this.detailOpen = true;
        this.focus = 'details';
      }
      this.render();
      return;
    }

    if (name === 'up' || name === 'k') {
      if (this.focus === 'details' && (wide || this.detailOpen)) {
        this.detailScrollOffset = Math.max(0, this.detailScrollOffset - 1);
      } else {
        this.selectedIndex = Math.max(0, this.selectedIndex - 1);
        this.detailScrollOffset = 0;
      }
      this.render();
      return;
    }

    if (name === 'down' || name === 'j') {
      if (this.focus === 'details' && (wide || this.detailOpen)) {
        this.detailScrollOffset += 1;
      } else {
        this.selectedIndex = Math.min(Math.max(0, this.cases.length - 1), this.selectedIndex + 1);
        this.detailScrollOffset = 0;
      }
      this.render();
    }
  }

  private render(): void {
    if (!this.stdout.isTTY) {
      return;
    }

    cursorTo(this.stdout, 0, 0);
    clearScreenDown(this.stdout);
    const frame = renderInteractiveWatchFrame({
      cycleNumber: this.cycleNumber,
      transactionsFetched: this.transactionsFetched,
      cases: this.cases,
      recentTransactions: this.recentTransactions,
      caseDefinitions: this.caseDefinitions,
      selectedIndex: this.selectedIndex,
      focus: this.focus,
      detailScrollOffset: this.detailScrollOffset,
      columns: this.ttyStdout?.columns,
      rows: this.ttyStdout?.rows,
      detailOpen: this.detailOpen
    });
    this.stdout.write(frame);
  }
}
