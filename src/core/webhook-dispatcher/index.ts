import { randomUUID } from 'node:crypto';
import type { ProviderConfig } from '../scenario-engine/config.js';
import { delay } from '../latency/index.js';
import { record, type LabLogger } from '../logging/index.js';
import { HttpError } from '../errors/index.js';
import { sendWebhook, retryable } from './transport.js';

// Only transport metadata: provider-specific payloads remain opaque serialized bodies.
export interface WebhookMessage { eventId: string; body: string }
export interface WebhookAttempt {
  eventId: string; destination: string; attemptNumber: number; requestedAt: string;
  responseStatus: number | null; responseTimeMs: number; success: boolean; error: string | null;
}
export interface DeliveryJob {
  jobId: string; message: WebhookMessage; config: ProviderConfig; retriesUsed: number; dueAt: number;
  lease?: { token: string; expiresAt: number; attemptNumber: number; requestedAt: string };
}
export interface DispatcherSnapshot { attempts: WebhookAttempt[]; attemptNumbers: [string, number][]; jobs: DeliveryJob[] }
export class WebhookDispatcher {
  attempts: WebhookAttempt[] = [];
  jobs: DeliveryJob[] = [];
  private tail: Promise<void> = Promise.resolve();
  private controller = new AbortController();
  private generation = 0;
  private pending = 0;
  private attemptNumbers = new Map<string, number>();
  constructor(private readonly logger: LabLogger, private readonly now: () => number = Date.now, private readonly deferred = false) {}
  snapshot(): DispatcherSnapshot { return structuredClone({ attempts: this.attempts, attemptNumbers: [...this.attemptNumbers], jobs: this.jobs }); }
  restore(snapshot: DispatcherSnapshot) { this.attempts = structuredClone(snapshot.attempts); this.attemptNumbers = new Map(snapshot.attemptNumbers); this.jobs = structuredClone(snapshot.jobs); }
  assertCapacity(count: number) {
    if ((this.deferred ? this.jobs.length : this.pending) + count > 1000) throw new HttpError(409, 'Webhook queue full; wait for delivery or reset');
  }
  enqueue(message: WebhookMessage, config: ProviderConfig, copies = 1) {
    if (!config.webhookDestination) return;
    this.assertCapacity(copies);
    const snapshot = structuredClone(config);
    if (this.deferred) {
      for (let copy = 0; copy < copies; copy++) this.jobs.push({ jobId: randomUUID(), message: { eventId: message.eventId, body: message.body }, config: snapshot, retriesUsed: 0, dueAt: this.now() });
      return;
    }
    const generation = this.generation;
    const signal = this.controller.signal;
    for (let copy = 0; copy < copies; copy++) {
      this.pending++;
      this.tail = this.tail.then(async () => {
        if (signal.aborted) return;
        await this.deliver(message, snapshot, generation, signal);
      }).catch(error => {
        if (!signal.aborted) this.logger.error({ eventId: message.eventId, err: error }, 'Webhook dispatcher error');
      }).finally(() => { if (generation === this.generation) this.pending--; });
    }
  }
  private async deliver(message: WebhookMessage, config: ProviderConfig, generation: number, signal: AbortSignal) {
    for (let retry = 0; retry <= config.webhookRetries; retry++) {
      if (signal.aborted) return;
      const attemptNumber = (this.attemptNumbers.get(message.eventId) ?? 0) + 1;
      this.attemptNumbers.set(message.eventId, attemptNumber);
      const attempt = await sendWebhook(message, config, attemptNumber, this.now, signal);
      if (generation !== this.generation || signal.aborted) return;
      this.attempts.push(attempt);
      if (this.attempts.length > 10000) this.attempts.shift();
      record(this.logger, 'webhook_attempt', { ...attempt });
      if (!retryable(attempt) || retry === config.webhookRetries) return;
      record(this.logger, 'webhook_retry_scheduled', { eventId: message.eventId, attemptNumber, delayMs: config.webhookRetryDelayMs });
      await delay(config.webhookRetryDelayMs, signal);
    }
  }
  async idle() { await this.tail; }
  reset() {
    this.generation++;
    this.controller.abort(); this.controller = new AbortController();
    this.tail = Promise.resolve(); this.pending = 0;
    this.attempts = []; this.jobs = []; this.attemptNumbers.clear();
  }
}
