import type { ProviderConfig } from './config.js';

export type Scenario = ProviderConfig['scenario'];
export class ScenarioEngine {
  constructor(private readonly random: () => number = Math.random) {}
  select(config: ProviderConfig): Scenario {
    return config.scenario !== 'NORMAL' && this.random() < config.errorRate ? config.scenario : 'NORMAL';
  }
  responseFailure(scenario: Scenario): number | undefined {
    return ({ RATE_LIMIT: 429, UNAUTHORIZED: 401, SERVER_ERROR: 500, UNAVAILABLE: 503 } as Partial<Record<Scenario, number>>)[scenario];
  }
}
