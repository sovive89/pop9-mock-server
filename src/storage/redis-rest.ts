import { HttpError } from '../core/errors/index.js';

export interface StateRepository {
  load(): Promise<string | null>;
  compareAndSet(expected: string | null, next: string): Promise<boolean>;
}
const casScript = `local current = redis.call('GET', KEYS[1])
if ARGV[1] == 'absent' then
  if current then return 0 end
elseif current ~= ARGV[2] then return 0 end
redis.call('SET', KEYS[1], ARGV[3])
return 1`;

// One isolated laboratory key. Atomic CAS prevents lost updates across function instances.
export class RedisRestRepository implements StateRepository {
  constructor(private readonly url: string, private readonly token: string, private readonly key = 'pop9-mock-server:v1:delivery-a') {
    if (new URL(url).protocol !== 'https:') throw new Error('Redis REST URL must use HTTPS');
  }
  private async command(command: (string | number)[]): Promise<unknown> {
    try {
      const response = await fetch(this.url, { method: 'POST', redirect: 'error',
        headers: { authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(command), signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('Redis HTTP failure');
      const result = await response.json() as { result?: unknown; error?: string };
      if (result.error) throw new Error('Redis command failure');
      return result.result;
    } catch { throw new HttpError(503, 'Laboratory persistence unavailable'); }
  }
  async load(): Promise<string | null> {
    const value = await this.command(['GET', this.key]);
    if (value !== null && typeof value !== 'string') throw new HttpError(503, 'Unexpected persistence response');
    return value;
  }
  async compareAndSet(expected: string | null, next: string): Promise<boolean> {
    if (Buffer.byteLength(next) > 4 * 1024 * 1024) throw new HttpError(409, 'Serverless laboratory storage limit reached; reset the provider');
    return await this.command(['EVAL', casScript, 1, this.key, expected === null ? 'absent' : 'present', expected ?? '', next]) === 1;
  }
}
