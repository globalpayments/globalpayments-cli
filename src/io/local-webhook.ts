import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const MAX_WEBHOOK_BYTES = 1_000_000;
const MAX_RESPONSE_BYTES = 64_000;
/** Set on every forwarded request so a listener chain that loops back is refused, not amplified. */
const FORWARDED_HEADER = 'x-globalpayments-cli-forwarded';

export interface LocalWebhookServerOptions {
  forwardTo: URL;
  onForward?: (status: number) => void;
  onReject?: (reason: string) => void;
  onError?: (error: unknown) => void;
  fetchImpl?: typeof fetch;
  appKey?: string;
}

export class LocalWebhookInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalWebhookInputError';
  }
}

export class LocalWebhookDeliveryError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    options: { cause?: unknown } = {}
  ) {
    super(message);
    this.name = 'LocalWebhookDeliveryError';
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

export function parseLocalForwardTarget(value: string): URL {
  let target: URL;
  try {
    target = new URL(value.includes('://') ? value : `http://${value}`);
  } catch {
    throw new LocalWebhookInputError('Forward target must be a local URL such as `http://localhost:3000/webhooks`.');
  }

  if (
    !['http:', 'https:'].includes(target.protocol) ||
    !isLoopbackHostname(target.hostname) ||
    target.username.length > 0 ||
    target.password.length > 0
  ) {
    throw new LocalWebhookInputError('Webhook forwarding is limited to an unauthenticated localhost HTTP(S) URL.');
  }
  return target;
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_WEBHOOK_BYTES) {
      throw new RangeError('Webhook payload exceeds the 1 MB limit.');
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

function forwardableHeaders(headers: IncomingHttpHeaders): Headers {
  const output = new Headers();
  for (const name of [
    'content-type',
    'content-encoding',
    'x-gp-signature',
    'x_global_transaction_id',
    'x_global_transaction_id_source'
  ]) {
    const value = headers[name];
    if (typeof value === 'string') {
      output.set(name, value);
    }
  }
  output.set(FORWARDED_HEADER, '1');
  return output;
}

async function sendForwardResponse(response: Response, target: ServerResponse): Promise<void> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        target.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        target.end('Forward target response exceeded the 64 KB limit.');
        return;
      }
      chunks.push(value);
    }
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const contentType = response.headers.get('content-type');
  target.writeHead(response.status, contentType ? { 'content-type': contentType } : {});
  target.end(bytes);
}

async function handleWebhookRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: LocalWebhookServerOptions
): Promise<void> {
  if (request.method !== 'POST') {
    options.onReject?.(`Rejected ${request.method ?? 'unknown'} request; only POST is supported.`);
    response.writeHead(405, { allow: 'POST' });
    response.end();
    return;
  }

  if (request.headers[FORWARDED_HEADER] !== undefined) {
    options.onReject?.('Rejected a webhook this CLI had already forwarded; the forward target loops back to a listener.');
    response.writeHead(508);
    response.end();
    return;
  }

  let body: Buffer;
  try {
    body = await readRequestBody(request);
  } catch (error) {
    if (error instanceof RangeError) {
      options.onReject?.(error.message);
      response.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(error.message);
      return;
    }
    throw error;
  }

  if (options.appKey !== undefined) {
    const signature = request.headers['x-gp-signature'];
    const encoding = request.headers['content-encoding']?.toLowerCase().trim();
    if (encoding && encoding !== 'identity' && encoding !== 'gzip') {
      options.onReject?.('Rejected webhook with unsupported content encoding.');
      response.writeHead(415);
      response.end();
      return;
    }
    let json: string;
    try {
      const decoded = encoding === 'gzip' ? gunzipSync(body, { maxOutputLength: MAX_WEBHOOK_BYTES }) : body;
      json = new TextDecoder('utf-8', { fatal: true }).decode(decoded);
      JSON.parse(json);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE') {
        options.onReject?.('Rejected decompressed webhook exceeding the 1 MB limit.');
        response.writeHead(413);
        response.end();
        return;
      }
      if (!(error instanceof SyntaxError) && !(error instanceof TypeError) &&
          !(error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code.startsWith('Z_'))) {
        throw error;
      }
      options.onReject?.('Rejected webhook with invalid JSON.');
      response.writeHead(400);
      response.end();
      return;
    }
    let minified = '';
    let inString = false;
    let escaped = false;
    for (const char of json) {
      if (inString) {
        minified += char;
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
      } else if (char === '"') {
        inString = true;
        minified += char;
      } else if (!' \t\r\n'.includes(char)) {
        minified += char;
      }
    }
    const expected = createHash('sha512').update(`${minified}${options.appKey}`).digest();
    const provided = typeof signature === 'string' && /^[a-f\d]{128}$/i.test(signature)
      ? Buffer.from(signature, 'hex')
      : Buffer.alloc(0);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      options.onReject?.('Rejected webhook with an invalid signature.');
      response.writeHead(401);
      response.end();
      return;
    }
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const forwarded = await fetchImpl(options.forwardTo, {
    method: 'POST',
    headers: forwardableHeaders(request.headers),
    body: new Uint8Array(body),
    signal: AbortSignal.timeout(15_000),
    redirect: 'error'
  });
  options.onForward?.(forwarded.status);
  await sendForwardResponse(forwarded, response);
}

export function createLocalWebhookServer(options: LocalWebhookServerOptions): Server {
  return createServer((request, response) => {
    void handleWebhookRequest(request, response, options).catch((error: unknown) => {
      options.onError?.(error);
      if (!response.headersSent) {
        response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      }
      response.end('Unable to forward webhook to the configured local endpoint.');
    });
  });
}

export async function listenOnLoopback(server: Server, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });

  const address = server.address() as AddressInfo | null;
  if (!address) {
    throw new Error('Webhook listener started without a network address.');
  }
  return address.port;
}
