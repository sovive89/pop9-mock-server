import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ServerlessRuntime, type LabSnapshot } from '../src/serverless/runtime.js';
import type { StateRepository } from '../src/storage/redis-rest.js';
import { defaultConfig } from '../src/core/scenario-engine/config.js';

class TestRepository implements StateRepository {
  value: string | null = null;
  conflicts = 0;
  async load() { return this.value; }
  async compareAndSet(expected: string | null, next: string) {
    if (this.conflicts > 0) { this.conflicts--; return false; }
    if (this.value !== expected) return false;
    this.value = next; return true;
  }
  state(): LabSnapshot { return JSON.parse(this.value!); }
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function target(statuses = [200], hold = false) {
  const bodies: string[] = [];
  let receive!: () => void;
  const received = new Promise<void>(resolve => { receive = resolve; });
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    bodies.push(body); receive();
    if (!hold) { response.writeHead(statuses[Math.min(bodies.length - 1, statuses.length - 1)]); response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies, received };
}
function runtime(repository: StateRepository, now?: () => number) { return new ServerlessRuntime(repository, { logger: false, now }); }
async function initialize(repo: TestRepository) { await runtime(repo).handle({ url: '/admin/providers/delivery-a/config' }); }
async function config(repo: TestRepository, payload: unknown) {
  const result = await runtime(repo).handle({ method: 'PATCH', url: '/admin/providers/delivery-a/config', payload: JSON.stringify(payload), headers: { 'content-type': 'application/json' } });
  expect(result.statusCode).toBe(200);
}
async function create(repo: TestRepository) { return runtime(repo).handle({ method: 'POST', url: '/delivery-a/test/orders', payload: '{}', headers: { 'content-type': 'application/json' } }); }

describe('Vercel persistence and durable dispatch', () => {
  it('preserves configuration and orders across separate function instances', async () => {
    const repository = new TestRepository();
    await config(repository, { latencyMs: 1 });
    const order = JSON.parse((await create(repository)).body);
    const loaded = await runtime(repository).handle({ url: `/delivery-a/orders/${order.order_id}` });
    expect(JSON.parse(loaded.body)).toEqual(order);
    const configuration = await runtime(repository).handle({ url: '/admin/providers/delivery-a/config' });
    expect(JSON.parse(configuration.body).latencyMs).toBe(1);
  });
  it('does not lose concurrent order creations', async () => {
    const repository = new TestRepository();
    await initialize(repository);
    const responses = await Promise.all(Array.from({ length: 8 }, () => create(repository)));
    expect(responses.every(response => response.statusCode === 201)).toBe(true);
    expect(new Set(responses.map(response => JSON.parse(response.body).order_id)).size).toBe(8);
    expect(repository.state().memory.orders).toHaveLength(10);
    expect(repository.state().memory.events).toHaveLength(8);
  });
  it('preserves quota across cold starts and concurrent requests', async () => {
    const repository = new TestRepository();
    await config(repository, { rateLimit: { enabled: true, requests: 2 } });
    const responses = await Promise.all(Array.from({ length: 5 }, () => runtime(repository).handle({ url: '/delivery-a/orders' })));
    expect(responses.filter(response => response.statusCode === 200)).toHaveLength(2);
    const blocked = responses.filter(response => response.statusCode === 429);
    expect(blocked).toHaveLength(3);
    expect(blocked.every(response => Number(response.headers['retry-after']) > 0)).toBe(true);
  });
  it('queues before sending and preserves duplicate bytes across workers', async () => {
    const receiver = await target();
    const repository = new TestRepository();
    await config(repository, { webhookDestination: receiver.url, scenario: 'DUPLICATE_EVENT' });
    await create(repository);
    expect(receiver.bodies).toHaveLength(0);
    expect(repository.state().dispatcher.jobs).toHaveLength(2);
    expect(await runtime(repository).dispatchOne()).toBe('delivered');
    expect(await runtime(repository).dispatchOne()).toBe('delivered');
    expect(receiver.bodies).toHaveLength(2);
    expect(receiver.bodies[0]).toBe(receiver.bodies[1]);
    expect(repository.state().dispatcher.attempts.map(attempt => attempt.attemptNumber)).toEqual([1, 2]);
  });
  it('persists scheduled retries with the same occurrence', async () => {
    const receiver = await target([503, 200]);
    const repository = new TestRepository();
    await config(repository, { webhookDestination: receiver.url, webhookRetries: 2, webhookRetryDelayMs: 10 });
    await create(repository);
    let now = Date.now();
    expect(await runtime(repository, () => now).dispatchOne()).toBe('delivered');
    const job = repository.state().dispatcher.jobs[0];
    expect(job.retriesUsed).toBe(1);
    expect(await runtime(repository, () => now).dispatchOne()).toBe('busy');
    now += 20;
    expect(await runtime(repository, () => now).dispatchOne()).toBe('delivered');
    expect(receiver.bodies[0]).toBe(receiver.bodies[1]);
    expect(repository.state().dispatcher.jobs).toHaveLength(0);
    expect(repository.state().dispatcher.attempts.map(attempt => attempt.responseStatus)).toEqual([503, 200]);
  });
  it('leases jobs so concurrent workers do not both send them', async () => {
    const receiver = await target();
    const repository = new TestRepository();
    await config(repository, { webhookDestination: receiver.url });
    await create(repository);
    const results = await Promise.all([runtime(repository).dispatchOne(), runtime(repository).dispatchOne()]);
    expect(results.sort()).toEqual(['busy', 'delivered']);
    expect(receiver.bodies).toHaveLength(1);
  });
  it('recovers a job after a terminated worker lease while keeping the message', async () => {
    const receiver = await target();
    const repository = new TestRepository();
    await config(repository, { webhookDestination: receiver.url });
    await create(repository);
    const state = repository.state();
    const body = state.dispatcher.jobs[0].message.body;
    state.dispatcher.jobs[0].lease = { token: 'terminated-worker', expiresAt: 0, attemptNumber: 1, requestedAt: new Date().toISOString() };
    state.dispatcher.attemptNumbers = [[state.dispatcher.jobs[0].message.eventId, 1]];
    repository.value = JSON.stringify(state);
    expect(await runtime(repository).dispatchOne()).toBe('delivered');
    expect(receiver.bodies[0]).toBe(body);
    expect(repository.state().dispatcher.attempts.at(-1)?.attemptNumber).toBe(2);
  });
  it('reset clears durable jobs and data and blocks delayed creation from resurfacing', async () => {
    const repository = new TestRepository();
    await config(repository, { latencyMs: 50, webhookDestination: 'https://example.invalid/webhook' });
    const delayed = create(repository).then(result => result, error => error);
    await new Promise(resolve => setTimeout(resolve, 10));
    const reset = await runtime(repository).handle({ method: 'POST', url: '/admin/providers/delivery-a/reset' });
    expect(reset.statusCode).toBe(200);
    expect((await delayed).statusCode).toBe(409);
    expect(repository.state().memory.config).toEqual(defaultConfig());
    expect(repository.state().memory.orders).toHaveLength(2);
    expect(repository.state().dispatcher.jobs).toHaveLength(0);
    expect(repository.state().memory.events).toHaveLength(0);
  });
  it('a reset during transport cannot bring an old attempt or retry back', async () => {
    const receiver = await target([200], true);
    const repository = new TestRepository();
    await config(repository, { webhookDestination: receiver.url, webhookTimeoutMs: 100, webhookRetries: 2 });
    await create(repository);
    const delivery = runtime(repository).dispatchOne();
    await receiver.received;
    await runtime(repository).handle({ method: 'POST', url: '/admin/providers/delivery-a/reset' });
    await delivery;
    expect(repository.state().dispatcher.attempts).toHaveLength(0);
    expect(repository.state().dispatcher.jobs).toHaveLength(0);
  });
  it('does not send uncommitted events during optimistic retries', async () => {
    const receiver = await target();
    const repository = new TestRepository();
    await config(repository, { webhookDestination: receiver.url });
    repository.conflicts = 2;
    await create(repository);
    expect(repository.state().memory.events).toHaveLength(1);
    expect(repository.state().dispatcher.jobs).toHaveLength(1);
    await runtime(repository).dispatchOne();
    expect(receiver.bodies).toHaveLength(1);
  });
});
