import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
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
});
