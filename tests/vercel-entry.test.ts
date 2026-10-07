import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const background = vi.hoisted(() => ({ promises: [] as Promise<unknown>[] }));
vi.mock('@vercel/functions', () => ({ waitUntil: (promise: Promise<unknown>) => { background.promises.push(promise); } }));
import handler from '../api/index.js';
import { RedisRestRepository } from '../src/storage/redis-rest.js';

const nativeFetch = globalThis.fetch;
const servers: Server[] = [];
let persisted: string | null;
let failRedis: boolean;
beforeEach(() => {
  persisted = null; failRedis = false;
  vi.stubEnv('ADMIN_TOKEN', 'vercel-admin-test');
  vi.stubEnv('DELIVERY_A_TOKEN', 'vercel-delivery-test');
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.mock.invalid');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'redis-test-token');
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) !== 'https://redis.mock.invalid') return nativeFetch(input, init);
    if (failRedis) return new Response('{}', { status: 503 });
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer redis-test-token');
    const command = JSON.parse(String(init?.body));
    if (command[0] === 'GET') return Response.json({ result: persisted });
    expect(command[0]).toBe('EVAL');
    expect(command[2]).toBe(1);
    const matches = command[4] === 'absent' ? persisted === null : persisted === command[5];
    if (matches) persisted = command[6];
    return Response.json({ result: matches ? 1 : 0 });
  });
});
afterEach(async () => {
  await Promise.all(background.promises.splice(0));
  for (const server of servers.splice(0)) await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
});
async function serve() {
  const server = createServer((request, response) => { void handler(request, response); });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('Vercel function HTTP entry and Redis REST adapter', () => {
  it('routes rewritten URLs, reads streamed JSON and persists orders', async () => {
    const base = await serve();
    const created = await fetch(`${base}/api/index?__lab_path=/delivery-a/test/orders`, {
      method: 'POST', headers: { authorization: 'Bearer vercel-delivery-test', 'content-type': 'application/json' }, body: '{}',
    });
    expect(created.status).toBe(201);
    expect(created.headers.get('cache-control')).toBe('no-store');
    const order = await created.json();
    const retrieved = await fetch(`${base}/api/index?__lab_path=/delivery-a/orders/${order.order_id}`, { headers: { authorization: 'Bearer vercel-delivery-test' } });
    expect(await retrieved.json()).toEqual(order);
    const list = await fetch(`${base}/api/index?__lab_path=/delivery-a/orders&store_id=STORE-001&limit=1`, { headers: { authorization: 'Bearer vercel-delivery-test' } });
    const envelope = await list.json();
    expect(envelope.data).toHaveLength(1);
    expect(envelope.pagination.total).toBe(2);
  });
  it('requires configured deployment credentials and separates worker authentication', async () => {
    const base = await serve();
    const worker = await fetch(`${base}/api/index?__lab_path=/admin/providers/delivery-a/webhooks/dispatch`, { method: 'POST', headers: { authorization: 'Bearer vercel-delivery-test' } });
    expect(worker.status).toBe(401);
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
    expect((await fetch(`${base}/api/index?__lab_path=/health`)).status).toBe(503);
  });
  it('reports persistence failure safely without leaking credentials', async () => {
    const base = await serve();
    failRedis = true;
    const result = await fetch(`${base}/api/index?__lab_path=/admin/providers`, { headers: { authorization: 'Bearer vercel-admin-test' } });
    expect(result.status).toBe(503);
    const body = await result.text();
    expect(body).toContain('persistence unavailable');
    expect(body).not.toContain('redis-test-token');
  });
  it('Redis adapter atomically checks expected state and enforces storage bounds', async () => {
    const repo = new RedisRestRepository('https://redis.mock.invalid', 'redis-test-token');
    expect(await repo.load()).toBeNull();
    expect(await repo.compareAndSet(null, 'first')).toBe(true);
    expect(await repo.compareAndSet(null, 'wrong')).toBe(false);
    expect(await repo.compareAndSet('first', 'second')).toBe(true);
    expect(await repo.load()).toBe('second');
    await expect(repo.compareAndSet('second', 'x'.repeat(4 * 1024 * 1024 + 1))).rejects.toMatchObject({ statusCode: 409 });
  });
});
