import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../core/authentication/index.js';
import { configPatchSchema, configSchema, scenarios } from '../core/scenario-engine/config.js';
import { HttpError } from '../core/errors/index.js';
import { record } from '../core/logging/index.js';
import type { MemoryStore } from '../storage/memory-store.js';
import type { RateLimiter } from '../core/rate-limit/index.js';
import type { WebhookDispatcher } from '../core/webhook-dispatcher/index.js';
import { page } from '../providers/delivery-a/schemas.js';

const historyQuery = z.strictObject({ offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(100).default(20) });
export async function adminRoutes(app: FastifyInstance, deps: { store: MemoryStore; dispatcher: WebhookDispatcher; limiter: RateLimiter; token?: string }) {
  const { store, dispatcher, limiter } = deps;
  const logger = app.log.child({ provider: 'delivery-a' });
  app.addHook('onRequest', async request => { authenticate(request, deps.token); });
  app.get('/providers', async () => ({ providers: [{ id: 'delivery-a', scenario: store.config.scenario, availableScenarios: scenarios }] }));
  app.get('/providers/delivery-a/config', async () => structuredClone(store.config));
  app.patch('/providers/delivery-a/config', async request => {
    const patch = configPatchSchema.parse(request.body);
    store.config = configSchema.parse({ ...store.config, ...patch, rateLimit: { ...store.config.rateLimit, ...patch.rateLimit } });
    if (patch.rateLimit) limiter.reset();
    record(logger, 'configuration_changed', { scenario: store.config.scenario, fields: Object.keys(patch) });
    return structuredClone(store.config);
  });
  app.post('/providers/delivery-a/reset', async () => {
    dispatcher.reset(); store.reset(); limiter.reset();
    record(logger, 'provider_reset', { scenario: store.config.scenario });
    return { reset: true, config: structuredClone(store.config) };
  });
  app.get('/providers/delivery-a/events', async request => {
    const q = historyQuery.parse(request.query);
    return page([...store.events.values()].map(event => ({ ...event, payload: JSON.parse(event.body), body: undefined })), q.offset, q.limit);
  });
  app.get('/providers/delivery-a/webhook-attempts', async request => {
    const q = historyQuery.parse(request.query); return page(dispatcher.attempts, q.offset, q.limit);
  });
  app.get('/providers/delivery-a/webhook-jobs', async request => {
    const q = historyQuery.parse(request.query);
    return page(dispatcher.jobs.map(job => ({ jobId: job.jobId, eventId: job.message.eventId, destination: job.config.webhookDestination, retriesUsed: job.retriesUsed, dueAt: new Date(job.dueAt).toISOString(), leased: Boolean(job.lease) })), q.offset, q.limit);
  });
  app.post<{ Params: { eventId: string } }>('/providers/delivery-a/events/:eventId/redeliver', async (request, reply) => {
    const event = store.events.get(request.params.eventId);
    if (!event) throw new HttpError(404, 'Event not found');
    if (!store.config.webhookDestination) throw new HttpError(409, 'Configure webhookDestination before redelivery');
    dispatcher.enqueue(event, store.config);
    record(logger, 'webhook_redelivery_requested', { eventId: event.eventId, scenario: event.scenario });
    return reply.code(202).send({ queued: true, eventId: event.eventId });
  });
}
