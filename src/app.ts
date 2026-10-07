import Fastify, { type FastifyError } from 'fastify';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { MemoryStore } from './storage/memory-store.js';
import { WebhookDispatcher } from './core/webhook-dispatcher/index.js';
import { ScenarioEngine } from './core/scenario-engine/engine.js';
import { RateLimiter } from './core/rate-limit/index.js';
import { DeliveryService } from './providers/delivery-a/service.js';
import { deliveryRoutes } from './providers/delivery-a/routes.js';
import { adminRoutes } from './admin/routes.js';

export interface AppOptions { logger?: boolean; logLevel?: string; adminToken?: string; deliveryToken?: string; now?: () => number; random?: () => number; deferredWebhooks?: boolean; skipLatency?: boolean }
export function buildApp(options: AppOptions = {}) {
  const app = Fastify({ logger: options.logger === false ? false : {
    level: options.logLevel ?? 'info', redact: ['req.headers.authorization', 'req.headers.cookie'],
  }, bodyLimit: 256 * 1024, genReqId: () => randomUUID() });
  const now = options.now ?? Date.now;
  const store = new MemoryStore();
  const providerLogger = app.log.child({ provider: 'delivery-a' });
  const dispatcher = new WebhookDispatcher(providerLogger, now, options.deferredWebhooks);
  const limiter = new RateLimiter(now);
  const engine = new ScenarioEngine(options.random);
  const service = new DeliveryService(store, dispatcher, providerLogger, now);
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: 'INVALID_INPUT', issues: error.issues.map(issue => ({ path: issue.path, message: issue.message })) });
    const status = typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (status >= 500) request.log.error({ err: error }, 'Request failed');
    return reply.code(status).send({ error: status >= 500 ? 'SERVER_FAILURE' : 'REQUEST_FAILED', message: status === 500 && !error.message.startsWith('Simulated') ? 'Internal server error' : error.message });
  });
  app.get('/health', async () => ({ status: 'ok', application: 'pop9-mock-server' }));
  app.register(async scope => deliveryRoutes(scope, { service, engine, limiter, token: options.deliveryToken, skipLatency: options.skipLatency }), { prefix: '/delivery-a' });
  app.register(async scope => adminRoutes(scope, { store, dispatcher, limiter, token: options.adminToken }), { prefix: '/admin' });
  app.addHook('onClose', async () => { dispatcher.reset(); });
  return { app, lab: { store, dispatcher, limiter } };
}
