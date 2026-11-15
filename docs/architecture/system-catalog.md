# NØUS Mock API Lab — catálogo por tipo de sistema

## Objetivo
Laboratório independente para simular APIs de sistemas heterogêneos, produzir tráfego HTTP/webhook e dados sintéticos reproduzíveis para testar o NØUS Contract Intelligence. Não conecta a contas reais de iFood/99Food.

## Organização
- `systems/<category>/<provider>/`: contrato, fixtures, eventos e cenários específicos do provedor.
- `src/core/`: infraestrutura reutilizável de HTTP, autenticação de laboratório, geração determinística, falhas, webhooks e telemetria.
- `docs/openapi/`: contratos OpenAPI próprios do laboratório e, quando validados, descrições de adaptadores.
- `tests/`: contratos, isolamento entre provedores, tráfego, falhas e repetibilidade.

Categorias planejadas: `delivery`, `pos`, `erp`, `crm`, `payments`, `logistics`. Pastas só serão criadas quando houver implementação ou documentação concreta.

## Regras para novos provedores
1. Manter schemas e payloads originais do provedor separados de contratos canônicos da NØUS.
2. Distinguir endpoints **oficiais verificados** de endpoints **inventados para o laboratório**.
3. Manter entidades mutáveis (loja, cliente, produto, pedido, pagamento), relações, estados e versões.
4. Gerar eventos com `seed` para repetição e com `scenario_run_id` para correlação.
5. Rotular ground truth em canal separado dos payloads observados pela IA.
6. Simular respostas HTTP, paginação, polling, webhook, retry, 429, 5xx, latência, duplicação, reorder e schema drift.
7. Não colocar credenciais reais, PII real ou dados comerciais no repositório.
8. Documentar APIs no OpenAPI/Swagger e testar conformidade dos exemplos.

## Estratégia de migração
O código legado em `src/providers/delivery-a` e `src/core` continua disponível na branch de trabalho para migração incremental. Não remover código funcional antes de portar os testes e garantir paridade. O backup imutável por convenção está em `backup/pop9-mock-original`.

## API do laboratório (proposta; não implementada)
- `POST /lab/scenarios`: iniciar cenário
- `POST /lab/scenarios/{id}/step`: avançar cenário
- `POST /lab/faults`: configurar injeção de falhas
- `GET /lab/runs/{id}/events`: observar eventos
- `GET /lab/runs/{id}/ground-truth`: resultados esperados (somente admin)
- `GET /docs`: Swagger UI, após integração do plugin OpenAPI

Os endpoints acima não são endpoints oficiais dos marketplaces.

## Ordem de entrega
1. Migrar `delivery-a` para `systems/delivery/delivery-a` preservando comportamento.
2. Implementar dois adaptadores simulados independentes em `systems/delivery/ifood` e `systems/delivery/99food`.
3. Criar gerador de entidades com seed e motor de cenários.
4. Instrumentar transporte webhook/HTTP, falhas e observabilidade.
5. Publicar OpenAPI e Swagger UI a partir das rotas efetivamente implementadas.
6. Integrar com NØUS IA Contract Intelligence e testar replay e idempotência ponta a ponta.
