import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Scenario } from '../../core/scenario-engine/engine.js';
import { ScenarioEngine } from '../../core/scenario-engine/engine.js';
import { RateLimiter } from '../../core/rate-limit/index.js';
import { authenticate } from '../../core/authentication/index.js';
import { delay } from '../../core/latency/index.js';
import { HttpError } from '../../core/errors/index.js';
import { record } from '../../core/logging/index.js';
import { DeliveryService } from './service.js';
import { createOrderSchema, createEventSchema, listQuerySchema, page } from './schemas.js';
import { presentOrder } from './events.js';
import { stores } from './fixtures/stores.js';
import { products } from './fixtures/products.js';

declare module 'fastify' { interface FastifyRequest { labScenario: Scenario } }
export async function deliveryRoutes(app: FastifyInstance, deps: {
  service: DeliveryService; engine: ScenarioEngine; limiter: RateLimiter; token?: string; skipLatency?: boolean;
}) {
  const { service, engine, limiter } = deps;
  const logger = app.log.child({ provider: 'delivery-a' });
  app.decorateRequest('labScenario', 'NORMAL');
  app.addHook('onRequest', async (request, reply) => {
    authenticate(request, deps.token);
    const config = structuredClone(service.store.config);
    const generation = service.store.orders;
    request.labScenario = engine.select(config);
    record(logger, 'request_received', { requestId: request.id, method: request.method, url: request.url, scenario: request.labScenario });
    const quota = limiter.consume(config.rateLimit);
    if (!quota.allowed) {
      if (config.rateLimit.includeRetryAfter) reply.header('Retry-After', String(quota.retryAfter));
      record(logger, 'rate_limit_reached', { requestId: request.id, retryAfter: quota.retryAfter, scenario: request.labScenario });
      throw new HttpError(429, 'Provider rate limit exceeded');
    }
    const latency = config.latencyMs + (request.labScenario === 'TIMEOUT' ? config.timeoutDelayMs : 0);
    if (latency && !deps.skipLatency) { record(logger, 'artificial_latency', { requestId: request.id, latencyMs: latency, scenario: request.labScenario }); await delay(latency); }
    // A request delayed across reset must never recreate records after reset.
    if (generation !== service.store.orders) throw new HttpError(409, 'Provider was reset during request');
    const status = engine.responseFailure(request.labScenario);
    if (status) {
      if (status === 429 && config.rateLimit.includeRetryAfter) reply.header('Retry-After', String(config.rateLimit.windowSeconds));
      record(logger, 'simulated_error', { requestId: request.id, statusCode: status, scenario: request.labScenario });
      throw new HttpError(status, `Simulated ${request.labScenario}`);
    }
  });
  app.addHook('onResponse', async (request, reply) => {
    record(logger, 'response_sent', { requestId: request.id, statusCode: reply.statusCode, responseTimeMs: reply.elapsedTime, scenario: request.labScenario });
  });
  const query = (request: FastifyRequest) => listQuerySchema.parse(request.query);
  app.get('/stores', async request => { const q = query(request); return page(stores.filter(store => !q.store_id || store.store_id === q.store_id), q.offset, q.limit); });
  app.get('/products', async request => { const q = query(request); return page(products.filter(product => !q.store_id || product.store_id === q.store_id), q.offset, q.limit); });
  app.get('/orders', async request => {
    const q = query(request);
    const orders = [...service.store.orders.values()].filter(order => (!q.store_id || order.store_id === q.store_id) && (!q.status || order.status === q.status));
    return page(orders.map(order => presentOrder(order, request.labScenario)), q.offset, q.limit);
  });
  app.get<{ Params: { id: string } }>('/orders/:id', async request => presentOrder(service.get(request.params.id), request.labScenario));
  app.post('/test/orders', async (request, reply) => {
    const order = service.create(createOrderSchema.parse(request.body ?? {}), request.labScenario);
    // OUT_OF_ORDER updates the stored status to PREPARING while preserving original snapshots.
    return reply.code(201).send(presentOrder(order, request.labScenario));
  });
  app.post<{ Params: { id: string } }>('/test/orders/:id/events', async (request, reply) => {
    const input = createEventSchema.parse(request.body);
    const event = service.emit(request.params.id, input.eventType, request.labScenario);
    return reply.code(201).send(JSON.parse(event.body));
  });
}
