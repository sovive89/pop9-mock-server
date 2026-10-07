import { randomUUID } from 'node:crypto';
import type { InjectOptions } from 'fastify';
import { buildApp, type AppOptions } from '../app.js';
import type { MemorySnapshot } from '../storage/memory-store.js';
import type { StateRepository } from '../storage/redis-rest.js';
import type { DeliveryJob, DispatcherSnapshot } from '../core/webhook-dispatcher/index.js';
import { sendWebhook, retryable } from '../core/webhook-dispatcher/transport.js';
import { HttpError } from '../core/errors/index.js';
import { delay } from '../core/latency/index.js';

export interface LabSnapshot {
  version: 1; memory: MemorySnapshot;
  limiter: { count: number; start: number | null }; dispatcher: DispatcherSnapshot;
}
type Lab = ReturnType<typeof buildApp>['lab'];
function snapshot(lab: Lab): LabSnapshot {
  return { version: 1, memory: lab.store.snapshot(), limiter: lab.limiter.snapshot(), dispatcher: lab.dispatcher.snapshot() };
}
function restore(lab: Lab, state: LabSnapshot) {
  if (state.version !== 1) throw new HttpError(503, 'Unsupported laboratory storage version');
  lab.store.restore(state.memory); lab.limiter.restore(state.limiter); lab.dispatcher.restore(state.dispatcher);
}

export class ServerlessRuntime {
  constructor(private readonly repository: StateRepository, private readonly options: AppOptions = {}) {}
  async handle(request: InjectOptions) {
    let initialGeneration: string | undefined;
    const randomSample = (this.options.random ?? Math.random)();
    for (let retry = 0; retry < 12; retry++) {
      const raw = await this.repository.load();
      const { app, lab } = buildApp({ ...this.options, random: () => randomSample, deferredWebhooks: true, skipLatency: retry > 0 });
      try {
        if (raw !== null) restore(lab, JSON.parse(raw));
        if (retry === 0) initialGeneration = raw === null ? undefined : lab.store.generation;
        else if (initialGeneration && initialGeneration !== lab.store.generation) throw new HttpError(409, 'Provider was reset during request');
        const result = await app.inject(request);
        const next = JSON.stringify(snapshot(lab));
        if (await this.repository.compareAndSet(raw, next)) {
          return { statusCode: result.statusCode, headers: result.headers, body: result.body };
        }
      } finally { await app.close(); }
    }
    throw new HttpError(503, 'Laboratory busy; retry this request');
  }
  private async mutate<T>(operation: (state: LabSnapshot) => T): Promise<T> {
    for (let retry = 0; retry < 12; retry++) {
      const raw = await this.repository.load();
      if (raw === null) throw new HttpError(409, 'Initialize the laboratory with an API request first');
      const state: LabSnapshot = JSON.parse(raw);
      if (state.version !== 1) throw new HttpError(503, 'Unsupported laboratory storage version');
      const result = operation(state);
      const next = JSON.stringify(state);
      if (next === raw || await this.repository.compareAndSet(raw, next)) return result;
    }
    throw new HttpError(503, 'Laboratory busy; retry dispatch');
  }
  async dispatchOne(): Promise<'delivered' | 'busy' | 'empty'> {
    const now = this.options.now ?? Date.now;
    const claimed = await this.mutate(state => {
      const job = state.dispatcher.jobs[0];
      if (!job) return { result: 'empty' as const };
      if (job.dueAt > now() || (job.lease && job.lease.expiresAt > now())) return { result: 'busy' as const };
      if (job.lease) {
        state.dispatcher.attempts.push({ eventId: job.message.eventId, destination: job.config.webhookDestination!,
          attemptNumber: job.lease.attemptNumber, requestedAt: job.lease.requestedAt, responseStatus: null,
          responseTimeMs: Math.max(0, now() - Date.parse(job.lease.requestedAt)), success: false, error: 'Worker interrupted; delivery outcome unknown' });
        if (state.dispatcher.attempts.length > 10000) state.dispatcher.attempts.shift();
      }
      const previous = state.dispatcher.attemptNumbers.find(([eventId]) => eventId === job.message.eventId);
      const attemptNumber = (previous?.[1] ?? 0) + 1;
      if (previous) previous[1] = attemptNumber;
      else state.dispatcher.attemptNumbers.push([job.message.eventId, attemptNumber]);
      job.lease = { token: randomUUID(), expiresAt: now() + job.config.webhookTimeoutMs + 10000, attemptNumber, requestedAt: new Date(now()).toISOString() };
      return { result: 'claimed' as const, job: structuredClone(job), generation: state.memory.generation };
    });
    if (claimed.result !== 'claimed') return claimed.result;
    const job: DeliveryJob = claimed.job;
    if (this.options.logger !== false) console.log(JSON.stringify({ labEvent: 'webhook_requested', provider: 'delivery-a', eventId: job.message.eventId, destination: job.config.webhookDestination, attemptNumber: job.lease!.attemptNumber, requestedAt: job.lease!.requestedAt }));
    const attempt = await sendWebhook(job.message, job.config, job.lease!.attemptNumber, now);
    const retryDueAt = await this.mutate(state => {
      const current = state.dispatcher.jobs.find(candidate => candidate.jobId === job.jobId);
      // Reset or another lease owns this job: never resurrect old state.
      if (!current || state.memory.generation !== claimed.generation || current.lease?.token !== job.lease!.token) return;
      state.dispatcher.attempts.push(attempt);
      if (state.dispatcher.attempts.length > 10000) state.dispatcher.attempts.shift();
      if (retryable(attempt) && current.retriesUsed < current.config.webhookRetries) {
        current.retriesUsed++;
        current.dueAt = now() + current.config.webhookRetryDelayMs;
        delete current.lease;
        return current.dueAt;
      } else state.dispatcher.jobs = state.dispatcher.jobs.filter(candidate => candidate.jobId !== job.jobId);
    });
    if (this.options.logger !== false) console.log(JSON.stringify({ labEvent: 'webhook_attempt', provider: 'delivery-a', ...attempt }));
    if (retryDueAt !== undefined && this.options.logger !== false) console.log(JSON.stringify({ labEvent: 'webhook_retry_scheduled', provider: 'delivery-a', eventId: job.message.eventId, attemptNumber: attempt.attemptNumber, dueAt: new Date(retryDueAt).toISOString() }));
    return 'delivered';
  }
  async drain(budgetMs = 90000, maxAttempts = 100) {
    const deadline = Date.now() + budgetMs;
    let delivered = 0;
    while (delivered < maxAttempts && Date.now() < deadline) {
      const raw = await this.repository.load();
      if (raw === null) break;
      const state: LabSnapshot = JSON.parse(raw);
      const head = state.dispatcher.jobs[0];
      if (!head) break;
      // Do not start a transport that would outlive this invocation's budget.
      if (Date.now() + head.config.webhookTimeoutMs + 10000 > deadline) break;
      const result = await this.dispatchOne();
      if (result === 'delivered') delivered++;
      else if (result === 'empty' || head.lease) break;
      else await delay(Math.min(250, Math.max(1, head.dueAt - (this.options.now ?? Date.now)())));
    }
    return { attemptsProcessed: delivered };
  }
}
