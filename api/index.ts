import { waitUntil } from '@vercel/functions';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { InjectOptions } from 'fastify';
import { RedisRestRepository } from '../src/storage/redis-rest.js';
import { ServerlessRuntime } from '../src/serverless/runtime.js';
import { HttpError } from '../src/core/errors/index.js';
import { timingSafeEqual } from 'node:crypto';

export default async function handler(request: IncomingMessage & { body?: unknown }, response: ServerResponse) {
  response.setHeader('Cache-Control', 'no-store');
  try {
    const adminToken = process.env.ADMIN_TOKEN;
    const deliveryToken = process.env.DELIVERY_A_TOKEN;
    const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
    const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!adminToken || !deliveryToken || adminToken === deliveryToken || !redisUrl || !redisToken) throw new HttpError(503, 'Configure distinct API tokens and dedicated laboratory Redis');
    const url = new URL(request.url ?? '/', 'https://mock.invalid');
    const route = url.searchParams.get('__lab_path') ?? url.pathname;
    url.searchParams.delete('__lab_path');
    const path = route + (url.search ? url.search : '');
    if (route === '/health') { response.statusCode = 200; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ status: 'ok', application: 'pop9-mock-server', storage: 'redis' })); return; }
    const repository = new RedisRestRepository(redisUrl, redisToken, process.env.LAB_REDIS_KEY);
    const runtime = new ServerlessRuntime(repository, { adminToken, deliveryToken, logLevel: process.env.LOG_LEVEL });
    if (route === '/admin/providers/delivery-a/webhooks/dispatch' && request.method === 'POST') {
      const actual = Buffer.from(request.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${adminToken}`);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new HttpError(401, 'Invalid or missing administrator token');
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(await runtime.drain()));
      return;
    }
    let payload: string | undefined;
    if (request.body !== undefined) payload = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
    else if (!['GET', 'HEAD'].includes(request.method ?? 'GET')) {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk); size += buffer.length;
        if (size > 256 * 1024) throw new HttpError(413, 'Request body too large');
        chunks.push(buffer);
      }
      if (size) payload = Buffer.concat(chunks).toString('utf8');
    }
    if (payload && Buffer.byteLength(payload) > 256 * 1024) throw new HttpError(413, 'Request body too large');
    const result = await runtime.handle({ method: (request.method ?? 'GET') as InjectOptions['method'], url: path, headers: request.headers, payload });
    response.statusCode = result.statusCode;
    for (const [name, value] of Object.entries(result.headers)) if (value !== undefined) response.setHeader(name, value);
    response.setHeader('Cache-Control', 'no-store');
    // Durable work is saved before replying. A killed invocation leaves jobs for the next call.
    if (result.statusCode < 400) waitUntil(runtime.drain().catch(error => console.error(JSON.stringify({ labEvent: 'dispatch_error', message: error instanceof HttpError ? error.message : 'Dispatcher failure' }))));
    response.end(result.body);
  } catch (error) {
    response.statusCode = error instanceof HttpError ? error.statusCode : 503;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ error: error instanceof HttpError ? error.message : 'Laboratory unavailable' }));
  }
}
