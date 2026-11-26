import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { buildTestPayRequest, registerApiCommands } from '../src/commands/api.js';
import { createApiSession } from '../src/core/api-session.js';
import { requestGpApi } from '../src/gpapi/request.js';

vi.mock('../src/core/api-session.js', () => ({ createApiSession: vi.fn() }));
vi.mock('../src/gpapi/request.js', () => ({ requestGpApi: vi.fn() }));

const options = {
  statusUrl: 'https://webhooks.example.test/status',
  returnUrl: 'https://webhooks.example.test/return',
  accountName: 'transaction_processing',
  amount: '100',
  currency: 'EUR',
  country: 'IE'
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  process.exitCode = 0;
});

describe('TestPay sandbox flow', () => {
  it('creates a TestPay request with distinct references and notification URLs', () => {
    const first = buildTestPayRequest(options);
    const second = buildTestPayRequest(options);
    expect(first).toMatchObject({
      amount: '100',
      payment_method: { apm: { provider: 'testpay' } },
      notifications: { status_url: options.statusUrl, return_url: options.returnUrl }
    });
    expect(first.reference).not.toBe(second.reference);
  });

  it.each([
    { ...options, statusUrl: 'http://example.test/status' },
    { ...options, statusUrl: 'https://localhost/status' },
    { ...options, statusUrl: 'https://127.0.0.1/status' },
    { ...options, returnUrl: 'https://user:password@example.test/' },
    { ...options, amount: '0' },
    { ...options, currency: 'eur' }
  ])('rejects invalid transaction input', (invalid) => {
    expect(() => buildTestPayRequest(invalid)).toThrow();
  });

  it.each(['sandbox', 'production'] as const)('uses the existing sandbox write boundary for %s', async (environment) => {
    vi.mocked(createApiSession).mockResolvedValue({
      config: { environment },
      authInput: { environment },
      authProvider: {}
    } as Awaited<ReturnType<typeof createApiSession>>);
    vi.mocked(requestGpApi).mockResolvedValue({ status: 201, body: { id: 'TRN_test', status: 'INITIATED' } });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const program = new Command();
    registerApiCommands(program);
    await program.parseAsync([
      'transactions', 'testpay',
      '--status-url', options.statusUrl,
      '--return-url', options.returnUrl,
      '--json'
    ], { from: 'user' });
    const envelope = JSON.parse(String(write.mock.calls.at(-1)?.[0]));
    if (environment === 'sandbox') {
      expect(envelope.ok).toBe(true);
      expect(vi.mocked(requestGpApi)).toHaveBeenCalledOnce();
      expect(vi.mocked(requestGpApi).mock.calls[0]?.[1]).toMatchObject({
        method: 'POST',
        path: '/transactions',
        body: { payment_method: { apm: { provider: 'testpay' } } }
      });
    } else {
      expect(envelope.ok).toBe(false);
      expect(envelope.error.code).toBe('E_CONFIG_INVALID');
      expect(vi.mocked(requestGpApi)).not.toHaveBeenCalled();
    }
  });
});
