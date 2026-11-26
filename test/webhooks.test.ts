import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  createLocalWebhookServer,
  listenOnLoopback,
  parseLocalForwardTarget
} from '../src/io/local-webhook.js';
import { createSyntheticWebhook } from '../src/commands/webhooks.js';
import { toGlobalPaymentsError } from '../src/contract/errors.js';
import { EXIT_CODES } from '../src/contract/exit-codes.js';
import { LocalWebhookDeliveryError } from '../src/io/local-webhook.js';

describe('local webhook tooling', () => {
  it('creates a GP-shaped sandbox event with a valid signature', () => {
    const now = new Date('2026-11-12T12:00:00.000Z');
    const webhook = createSyntheticWebhook('transaction.captured', 'app-id', 'app-key', now);
    expect(webhook.payload).toMatchObject({
      type: 'SALE',
      status: 'CAPTURED',
      amount: '1000',
      currency: 'USD',
      action: { type: 'STATUS_NOTIFICATION', app_id: 'app-id' }
    });
    expect(webhook.signature).toBe(createHash('sha512').update(`${webhook.body}app-key`).digest('hex'));
  });

  it('rejects unknown event names and non-local forwarding targets', () => {
    expect(() => createSyntheticWebhook('transaction.fake', 'app-id', 'app-key')).toThrow(/Unsupported webhook event/);
    expect(() => parseLocalForwardTarget('https://example.com/webhook')).toThrow(/localhost/);
    expect(() => parseLocalForwardTarget('http://user:pass@localhost/webhook')).toThrow(/localhost/);
    let inputError: unknown;
    try {
      parseLocalForwardTarget('https://example.com/webhook');
    } catch (error) {
      inputError = error;
    }
    expect(toGlobalPaymentsError(inputError).exitCode).toBe(EXIT_CODES.USAGE);
    expect(toGlobalPaymentsError(new LocalWebhookDeliveryError('receiver unavailable')).exitCode).toBe(
      EXIT_CODES.WEBHOOK_DELIVERY
    );
  });

  it('forwards a local POST while preserving only webhook headers', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('accepted', { status: 202 }));
    const server = createLocalWebhookServer({
      forwardTo: parseLocalForwardTarget('http://localhost:3000/webhooks'),
      fetchImpl
    });

    const port = await listenOnLoopback(server, 0);

    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-gp-signature': 'signature',
          authorization: 'should-not-forward'
        },
        body: '{"id":"TRN_TEST"}'
      });

      expect(response.status).toBe(202);
      expect(await response.text()).toBe('accepted');
      const [target, init] = fetchImpl.mock.calls[0] ?? [];
      expect(String(target)).toBe('http://localhost:3000/webhooks');
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('x-gp-signature')).toBe('signature');
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('forwards only correctly signed JSON when signature verification is enabled', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('accepted', { status: 200 }));
    const server = createLocalWebhookServer({
      forwardTo: parseLocalForwardTarget('http://localhost:3000/webhooks'),
      appKey: 'app-key',
      fetchImpl
    });
    const port = await listenOnLoopback(server, 0);
    try {
      const body = '{ "id": "TRN_TEST" }';
      const signature = createHash('sha512').update('{"id":"TRN_TEST"}app-key').digest('hex');
      const send = (payload: string, value: string) => fetch(`http://127.0.0.1:${port}/`, {
        method: 'POST', headers: { 'x-gp-signature': value }, body: payload
      });
      expect((await send(body, signature)).status).toBe(200);
      expect((await send(body, '0'.repeat(128))).status).toBe(401);
      expect((await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body })).status).toBe(401);
      expect((await send('{invalid', signature)).status).toBe(400);
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('verifies gzip payloads without changing JSON values or forwarded bytes', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const server = createLocalWebhookServer({
      forwardTo: parseLocalForwardTarget('http://localhost:3000/webhooks'),
      appKey: 'app-key',
      fetchImpl
    });
    const port = await listenOnLoopback(server, 0);
    try {
      const body = '{ "number": 12345678901234567890, "text": "a b" }';
      const signature = createHash('sha512').update('{"number":12345678901234567890,"text":"a b"}app-key').digest('hex');
      const compressed = gzipSync(body);
      const send = (payload: Uint8Array, encoding: string) => fetch(`http://127.0.0.1:${port}/`, {
        method: 'POST', headers: { 'x-gp-signature': signature, 'content-encoding': encoding }, body: new Uint8Array(payload)
      });
      expect((await send(compressed, 'gzip')).status).toBe(204);
      expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get('content-encoding')).toBe('gzip');
      expect(fetchImpl.mock.calls[0]?.[1]?.body).toEqual(new Uint8Array(compressed));
      expect((await send(new Uint8Array([0]), 'gzip')).status).toBe(400);
      expect((await send(compressed, 'br')).status).toBe(415);
      expect((await send(gzipSync(`"${'x'.repeat(1_000_000)}"`), 'gzip')).status).toBe(413);
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('caps the response body forwarded from the local receiver', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(64_001));
        }
      }), { status: 200 })
    );
    const server = createLocalWebhookServer({
      forwardTo: parseLocalForwardTarget('http://localhost:3000/webhooks'),
      fetchImpl
    });
    const port = await listenOnLoopback(server, 0);

    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        method: 'POST',
        body: '{}'
      });
      expect(response.status).toBe(502);
      expect(await response.text()).toContain('64 KB limit');
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  // The worked example from GP's "Validating Webhook Notifications" page
  // (developer.globalpayments.com/api/definitions/webhooks), sent pretty-printed and
  // gzipped the way GP delivers it, so the listener must minify before hashing.
  it('verifies the signature of the example webhook in the GP documentation', async () => {
    const documented = {
      id: 'TRN_wRWA1rOQeVRDUOafRmirrpYPURPODJ_44819181', time_created: '2024-07-03T15:23:51.342Z', type: 'SALE',
      status: 'CAPTURED', channel: 'CNP', capture_mode: 'AUTO', amount: '1005', currency: 'EUR', country: 'DE',
      merchant_id: 'MER_f414851d386a4e1f9fa4beb56c5e38b9', merchant_name: 'Global Payments Test Merchant Mason',
      account_id: 'TRA_4d49f5d4e1b84ea4a28c8902a8538375', account_name: '79810948', reference: '44819181',
      payment_method: {
        result: '00', message: 'SUCCEEDED', entry_mode: 'ECOM',
        apm: {
          provider: 'testpay', wait_notification: '', fund_status: 'NOT_EXPECTED', payment_description: '546CCB7',
          confirmed_accountholder: '', account_number: '', iban: '', bank_identifier_code: '', bank_name: '',
          bank_address: '', optional_redirect: ''
        }
      },
      batch_id: '',
      action: {
        id: 'ACT_Jm6BviEawzx7XgbQZUh0dbfBettgQ5', type: 'STATUS_NOTIFICATION', time_created: '2024-07-03T15:24:52.217Z',
        result_code: 'SUCCESS', app_id: 'a5f0OOTJdAChObGXIqi8I5eGq6i6sLlJ', app_name: 'sean_sandbox_app'
      }
    };
    const signature =
      'ee16e2d14fb2969565499c172522e69955945a544751a5fa9e5fc775b3141785612c223ed77c2ff4cc367ead60f816c4fec6e16dc35564882d9aa695a3d0a907';
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    const server = createLocalWebhookServer({
      forwardTo: parseLocalForwardTarget('http://localhost:3000/webhooks'),
      appKey: 'WinZP9PgPfVZuTi4',
      fetchImpl
    });
    const port = await listenOnLoopback(server, 0);
    const send = (body: string, sig: string): Promise<Response> =>
      fetch(`http://127.0.0.1:${port}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', 'x-gp-signature': sig },
        body: gzipSync(body)
      });

    try {
      expect((await send(JSON.stringify(documented, null, 3), signature)).status).toBe(200);
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      const tampered = JSON.stringify({ ...documented, amount: '100500' }, null, 3);
      expect((await send(tampered, signature)).status).toBe(401);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('reports a busy listener port as a usage error with the fix', async () => {
    const blocker = createLocalWebhookServer({ forwardTo: parseLocalForwardTarget('http://localhost:3000/webhooks') });
    const port = await listenOnLoopback(blocker, 0);
    try {
      const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
      const result = spawnSync(
        process.execPath,
        ['--import', tsx, path.resolve('src', 'bin.ts'), 'listen', '--forward-to', 'http://localhost:3000/webhooks',
          '--port', String(port), '--timeout', '1s', '--json'],
        { encoding: 'utf8' }
      );

      expect(result.status).toBe(EXIT_CODES.USAGE);
      const envelope = JSON.parse(result.stdout);
      expect(envelope.error.message).toMatch(new RegExp(`Port ${port} is already in use`));
      expect(envelope.error.remediation).toMatch(/--port/);
    } finally {
      blocker.close();
      await once(blocker, 'close');
    }
  }, 15_000);

  it('refuses to forward a listener to its own port', () => {
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
    const result = spawnSync(
      process.execPath,
      ['--import', tsx, path.resolve('src', 'bin.ts'), 'listen', '--forward-to', 'http://localhost:47811/',
        '--port', '47811', '--timeout', '5s', '--json'],
      { encoding: 'utf8', timeout: 10_000 }
    );

    expect(result.status).toBe(EXIT_CODES.USAGE);
    expect(JSON.parse(result.stdout).error.message).toMatch(/points back at this listener/);
  }, 15_000);

  it('refuses a request it already forwarded instead of looping', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    const server = createLocalWebhookServer({
      forwardTo: parseLocalForwardTarget('http://localhost:3000/webhooks'),
      fetchImpl
    });
    const port = await listenOnLoopback(server, 0);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-globalpayments-cli-forwarded': '1' },
        body: '{}'
      });
      expect(response.status).toBe(508);
      expect(fetchImpl).not.toHaveBeenCalled();

      await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: '{}' });
      expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get('x-globalpayments-cli-forwarded')).toBe('1');
    } finally {
      server.close();
      await once(server, 'close');
    }
  });
});
