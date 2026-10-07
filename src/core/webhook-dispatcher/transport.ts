import { performance } from 'node:perf_hooks';
import type { ProviderConfig } from '../scenario-engine/config.js';
import type { WebhookAttempt, WebhookMessage } from './index.js';

export async function sendWebhook(message: WebhookMessage, config: ProviderConfig, attemptNumber: number, now: () => number, signal?: AbortSignal): Promise<WebhookAttempt> {
  const destination = config.webhookDestination!;
  const requestedAt = new Date(now()).toISOString();
  const started = performance.now();
  let responseStatus: number | null = null;
  let error: string | null = null;
  let success = false;
  try {
    const response = await fetch(destination, {
      method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: message.body,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(config.webhookTimeoutMs)]) : AbortSignal.timeout(config.webhookTimeoutMs),
    });
    responseStatus = response.status;
    success = response.ok;
    await response.body?.cancel();
    if (!success) error = `HTTP ${response.status}`;
  } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
  return { eventId: message.eventId, destination, attemptNumber, requestedAt, responseStatus,
    responseTimeMs: Math.round(performance.now() - started), success, error };
}
export function retryable(attempt: WebhookAttempt): boolean {
  return !attempt.success && (attempt.responseStatus === null || attempt.responseStatus === 408 || attempt.responseStatus === 429 || attempt.responseStatus >= 500);
}
