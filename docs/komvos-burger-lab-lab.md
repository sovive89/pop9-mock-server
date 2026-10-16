# KømVøS — Burger Lab integration laboratory

Status: implementation specification; not yet an implemented provider or a verified live API.

## Scope
Preserve existing Delivery A endpoints, fixtures, auth, webhooks, and tests without changing their contracts.
Add independent `ifood` and `99food` simulated providers. They are NOT official API implementations until validated against current provider documentation. No production credentials, real merchant calls, or deployment in this phase.

## Fixture organization
- tenant: `burger-lab` (fictional).
- `UNIT-001`: Burger Lab Guará.
  - `IFD-001` on simulated iFood; `99F-001` on simulated 99Food.
  - `BURGER-001`: Hambúrguer clássico, BRL 25.00.
  - `FRIES-001`: Batata frita, BRL 12.00.
- `UNIT-002`: Burger Lab Águas Claras.
  - `IFD-002` on simulated iFood; `99F-002` on simulated 99Food.
  - `CHEESE-001`: Cheeseburger, BRL 28.00.
  - `SODA-001`: Refrigerante, BRL 7.00.

Both marketplaces list the same two products within each unit. External marketplace item IDs are distinct from internal IDs. Never match products by name alone. Monetary values use integer centavos internally.

## Contract boundaries
1. Provider RAW: provider-specific payload preserved byte-for-byte alongside provider name, event ID, external merchant ID, reception time, and contract version.
2. Mapping: provider-specific validated adapter maps external merchant and product IDs to unit and product IDs; unknown mappings fail explicitly or quarantine, never silently guess.
3. KømVøS canonical: independent of providers and ERP, with tenant, unit, origin, external IDs, items, prices, payment, status, timestamps, and schema version. Canonical schema belongs to KømVøS, NOT this mock server.

## Simulated onboarding
- KømVøS creates network and units internally.
- For each unit/provider pair, mock an authorization request and approval with distinct connection state.
- Four independent links; disconnecting one must not disconnect others.
- Never store or expose production secrets. Mock authorization is not official OAuth.

## Test scenarios
- Four simultaneous order streams, one per connection.
- Correct unit isolation and network-level aggregation.
- Distinct RAW payload shapes normalized to same canonical meaning.
- Duplicate event ID and retry are idempotent; event history and RAW preserved.
- Cancellation, out-of-order event, timeout, transient 429/5xx, recovery.
- Unknown merchant/product mapping quarantined and auditable.
- Existing Delivery A regression suite passes unchanged.

## Implementation order
1. Verify official iFood contracts and accessible 99Food contracts; mark any unverified fields as synthetic.
2. Add fixtures and per-provider schemas/routes to Mock Server.
3. Add independent authorization simulation and webhook dispatch.
4. Implement KømVøS mapping/canonical validation in KømVøS repository.
5. Test locally and against protected preview before any production deployment.
