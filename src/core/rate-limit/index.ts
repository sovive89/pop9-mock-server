import type { ProviderConfig } from '../scenario-engine/config.js';

export class RateLimiter {
  private count = 0;
  private start: number | undefined;
  constructor(private readonly now: () => number = Date.now) {}
  reset() { this.count = 0; this.start = undefined; }
  snapshot() { return { count: this.count, start: this.start ?? null }; }
  restore(snapshot: { count: number; start: number | null }) { this.count = snapshot.count; this.start = snapshot.start ?? undefined; }
  consume(config: ProviderConfig['rateLimit']): { allowed: boolean; retryAfter: number } {
    if (!config.enabled) return { allowed: true, retryAfter: 0 };
    const now = this.now();
    if (this.start === undefined || now - this.start >= config.windowSeconds * 1000) { this.start = now; this.count = 0; }
    const retryAfter = Math.max(1, Math.ceil((this.start + config.windowSeconds * 1000 - now) / 1000));
    if (this.count >= config.requests) return { allowed: false, retryAfter };
    this.count++;
    return { allowed: true, retryAfter };
  }
}
