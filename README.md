# pop9-mock-server

Laboratório independente de integração do ecossistema Pop9. Simula sistemas externos para testar consumidores de APIs e webhooks sem credenciais ou sandboxes de fornecedores. A primeira versão implementa somente **Delivery A**, um contrato fictício próprio.

Não se conecta ao banco do ERP ou do Hub. Não contém modelo canônico, MDM, SDK, event bus, transformação Pop9 nem integrações de produção. O diretório e o serviço podem ser removidos sem afetar outros projetos.

**Hospedagem escolhida: Vercel.** A execução local continua em memória; a versão serverless usa um Redis Upstash separado, exclusivo do laboratório. Essa alteração mantém o estado entre chamadas e evita depender de memória temporária das funções. Não é um banco do ERP/Hub.

## Executar

Requisito: Node.js 24 LTS e npm.

```sh
cd pop9-mock-server
npm ci
cp .env.example .env
npm run dev
```

Por padrão: `http://127.0.0.1:3000`. Em desenvolvimento, os tokens são opcionais. Se definidos, use `Authorization: Bearer <token>` nas respectivas APIs.

```sh
npm run typecheck
npm test
npm run build
npm start
```

Em produção, `ADMIN_TOKEN` e `DELIVERY_A_TOKEN` são obrigatórios e devem ser diferentes. O servidor recusa iniciar sem eles. `/health` é público, retorna somente a saúde do processo e fica fora dos cenários.

## Estrutura

```text
src/
  app.ts                       fábrica da aplicação e composição dos módulos
  server.ts                    execução, ambiente e encerramento
  core/
    scenario-engine/           seleção de cenário e configuração
    authentication/            validação dos tokens do laboratório
    latency/                   atraso artificial
    errors/                    erros HTTP do laboratório
    rate-limit/                quota por provider
    webhook-dispatcher/        transporte, retries e tentativas
    logging/                   registros estruturados
  providers/
    delivery-a/
      routes.ts                API externa simulada
      schemas.ts               contrato exclusivo da Delivery A
      service.ts               criação de pedidos e ocorrências fictícias
      events.ts                snapshots e defeitos no payload
      fixtures/                lojas, produtos, clientes e pedidos fictícios
  admin/routes.ts              configuração, inspeção, reset e redelivery
  storage/memory-store.ts      estado local da Delivery A
  storage/redis-rest.ts        persistência serverless via REST e CAS atômico
  serverless/runtime.ts       transações de estado e entregas persistidas
api/index.ts                  entrada HTTP da Vercel
vercel.json                   rotas e limite da função
tests/                        contratos, cenários, transporte, concorrência e reset
```

Os fixtures estão no provider porque pertencem ao contrato dele. Os cenários são funções, em vez de diretórios de dados por cenário. Não há providers vazios de ERP/POS, pagamento ou fiscal. Um futuro provider deverá possuir seus próprios schemas, fixtures e armazenamento; poderá reutilizar os mecanismos técnicos do núcleo sem normalizar dados comerciais.

## Endpoints

| Método | Caminho | Descrição |
| --- | --- | --- |
| GET | `/health` | Saúde do processo |
| GET | `/delivery-a/stores` | Lojas fictícias |
| GET | `/delivery-a/products` | Produtos e adicionais |
| GET | `/delivery-a/orders` | Pedidos |
| GET | `/delivery-a/orders/:id` | Pedido completo; 404 se inexistente |
| POST | `/delivery-a/test/orders` | Cria pedido; 201; gera ORDER_CREATED |
| POST | `/delivery-a/test/orders/:id/events` | Gera nova ocorrência; 201 |
| GET | `/admin/providers` | Providers e cenários disponíveis |
| GET | `/admin/providers/delivery-a/config` | Configuração atual |
| PATCH | `/admin/providers/delivery-a/config` | Alteração parcial validada |
| POST | `/admin/providers/delivery-a/reset` | Restaura laboratório |
| GET | `/admin/providers/delivery-a/events` | Histórico das ocorrências |
| GET | `/admin/providers/delivery-a/webhook-attempts` | Histórico de entregas |
| GET | `/admin/providers/delivery-a/webhook-jobs` | Entregas pendentes; preenchido no modo Vercel |
| POST | `/admin/providers/delivery-a/webhooks/dispatch` | Processa fila persistida; somente Vercel |
| POST | `/admin/providers/delivery-a/events/:eventId/redeliver` | Agenda reenvio; 202 |

Listas usam `offset` e `limit` (padrão 20, máximo 100). Produtos aceitam `store_id`; pedidos aceitam `store_id` e `status`.

```json
{
  "data": [],
  "pagination": { "offset": 0, "limit": 20, "total": 0 }
}
```

Para os exemplos, configure as variáveis locais abaixo; substitua os tokens pelos seus valores. Se executar sem autenticação local, omita os headers.

```sh
BASE_URL='http://127.0.0.1:3000'
ADMIN_TOKEN='seu-token-administrativo'
DELIVERY_A_TOKEN='seu-token-delivery'

curl "$BASE_URL/delivery-a/products?store_id=STORE-001" \
  -H "Authorization: Bearer $DELIVERY_A_TOKEN"
```

## Pedido fictício

```sh
curl -X POST "$BASE_URL/delivery-a/test/orders" \
  -H "Authorization: Bearer $DELIVERY_A_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "store_id": "STORE-001",
    "items": [{
      "product_id": "PRODUCT-001",
      "quantity": 2,
      "modifiers": [{ "modifier_id": "MOD-001", "quantity": 1 }]
    }],
    "delivery_fee": 700,
    "discount": 500,
    "payment_method": "PIX"
  }'
```

O corpo vazio `{}` (ou ausência de corpo) cria um pedido com produtos padrão da loja. Produtos e adicionais devem pertencer à loja/produto selecionados. Não são aceitos clientes ou dados pessoais enviados pelo usuário: os clientes vêm exclusivamente de fixtures fictícios com e-mails `example.invalid`.

O pedido de exemplo retornará os seguintes valores, com ID e data gerados:

```json
{
  "order_id": "DEL-<uuid>",
  "store_id": "STORE-001",
  "created_at": "2026-10-07T12:00:00.000Z",
  "customer": {
    "customer_id": "CUSTOMER-001",
    "display_name": "Cliente fictício 001",
    "email": "cliente001@example.invalid"
  },
  "items": [{
    "product_id": "PRODUCT-001",
    "name": "Hambúrguer artesanal",
    "quantity": 2,
    "unit_price": 3200,
    "modifiers": [{
      "modifier_id": "MOD-001",
      "name": "Queijo extra",
      "quantity": 1,
      "unit_price": 400
    }],
    "line_total": 7200
  }],
  "subtotal": 7200,
  "delivery_fee": 700,
  "discount": 500,
  "total": 7400,
  "currency": "BRL",
  "payment": { "method": "PIX", "status": "PAID" },
  "status": "CREATED"
}
```

Valores monetários são centavos inteiros. Datas são ISO 8601 UTC. A quantidade do adicional é por unidade do produto. `line_total = quantity × (unit_price + soma dos adicionais)`. `subtotal` soma os itens; `total = subtotal + delivery_fee - discount`. Desconto acima do valor do pedido é rejeitado. Essas são convenções exclusivas do simulador Delivery A.

Métodos de pagamento: `PIX`, `CREDIT_CARD`, `DEBIT_CARD`, `CASH`. Dinheiro gera pagamento `PENDING`; os demais geram `PAID`.

## Webhooks e ocorrências

Tipos disponíveis: `ORDER_CREATED`, `ORDER_CONFIRMED`, `ORDER_PREPARING`, `ORDER_READY`, `ORDER_DISPATCHED`, `ORDER_DELIVERED`, `ORDER_CANCELLED`.

```json
{
  "eventId": "EVT-<uuid>",
  "eventType": "ORDER_CREATED",
  "occurredAt": "2026-10-07T12:00:00.000Z",
  "orderId": "DEL-<uuid>",
  "data": { "order": { "order_id": "DEL-<uuid>", "store_id": "STORE-001", "status": "CREATED" } }
}
```

O exemplo acima abrevia `data.order`: o envio real contém o pedido completo no contrato Delivery A. Não é um envelope canônico Pop9.

**eventId identifica a ocorrência; orderId identifica o pedido.** Cada chamada de geração cria novo eventId, mesmo para um pedido e tipo de evento já existentes. Atualiza o status do pedido para corresponder ao evento, sem impor uma máquina de estados real de negócio: o laboratório permite sequências arbitrárias.

O snapshot da ocorrência é serializado uma vez. Duplicação, retry e redelivery usam os mesmos bytes, eventId e occurredAt, inclusive quando o pedido ou cenário mudarem depois. O horário da tentativa fica em `requestedAt`, fora da ocorrência.

Configurar destino:

```sh
curl -X PATCH "$BASE_URL/admin/providers/delivery-a/config" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"webhookDestination":"https://seu-receptor-de-testes.example/webhooks/delivery-a","webhookRetries":2,"webhookRetryDelayMs":500,"webhookTimeoutMs":3000}'
```

A URL de exemplo precisa ser substituída por um receptor real de testes. URLs HTTP e HTTPS são aceitas; redirects não são seguidos. `null` desativa novos envios. Sem destino, ocorrências continuam registradas e podem ser reenviadas depois da configuração.

```sh
ORDER_ID='ID-retornado-na-criacao'
curl -X POST "$BASE_URL/delivery-a/test/orders/$ORDER_ID/events" \
  -H "Authorization: Bearer $DELIVERY_A_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"eventType":"ORDER_CONFIRMED"}'

EVENT_ID='ID-da-ocorrencia-original'
curl -X POST "$BASE_URL/admin/providers/delivery-a/events/$EVENT_ID/redeliver" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Na execução local, o dispatcher executa uma fila serial por instância. Na Vercel, a fila fica no Redis e cada envio precisa de uma reserva atômica temporária (lease), preservando a ordem entre workers. O POST responde sem aguardar o receptor. Respostas 2xx são sucesso. Falhas de rede, timeout, HTTP 408, 429 e 5xx permitem retries; outros 4xx são falhas permanentes. `webhookRetries` significa tentativas adicionais à primeira. O intervalo é fixo, definido por `webhookRetryDelayMs`; o dispatcher não interpreta Retry-After do receptor nesta versão.

Cada tentativa registra eventId, destination, attemptNumber, requestedAt, responseStatus, responseTimeMs, success e error. Sem resposta, responseStatus é null. attemptNumber continua crescendo para o mesmo eventId em duplicações e reenvios manuais. Uma alteração de configuração vale para novos agendamentos: a fila existente mantém sua configuração original.

## Cenários

| Cenário | Efeito |
| --- | --- |
| NORMAL | Respostas e eventos regulares |
| DUPLICATE_EVENT | Duas entregas da mesma ocorrência, cada uma com seus retries possíveis |
| RATE_LIMIT | HTTP 429 forçado, mesmo sem esgotar a quota |
| UNAUTHORIZED | HTTP 401 forçado |
| SERVER_ERROR | HTTP 500 forçado |
| UNAVAILABLE | HTTP 503 forçado |
| TIMEOUT | Resposta adiada por latencyMs + timeoutDelayMs |
| OUT_OF_ORDER | Na criação, gera CREATED → READY → PREPARING, com três IDs diferentes |
| MISSING_FIELD | Remove store_id dos pedidos apresentados e dos novos snapshots |
| UNKNOWN_FIELD | Adiciona experimental_delivery_hint aos pedidos apresentados e novos snapshots |
| INVALID_PAYLOAD | JSON válido, mas items é string e total é objeto |

TIMEOUT deve usar `timeoutDelayMs` maior que o timeout do consumidor. Após o atraso, a resposta é normal se a conexão continuar aberta. Os cenários HTTP não criam pedidos ou ocorrências quando retornam erro. Os cenários de payload não corrompem o registro original em memória. Em OUT_OF_ORDER, o pedido armazenado termina PREPARING, e os snapshots preservam cada status emitido.

`errorRate` (0 a 1) é a probabilidade de aplicar o cenário selecionado a cada requisição. Com 1, ele é determinístico; com 0, não é aplicado. NORMAL nunca gera falhas aleatórias. Autenticação real e quota real são independentes dessa probabilidade. A API administrativa e `/health` não sofrem cenários, quota ou latência.

Ativar duplicação:

```sh
curl -X PATCH "$BASE_URL/admin/providers/delivery-a/config" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"scenario":"DUPLICATE_EVENT","errorRate":1}'
```

Depois, crie um pedido ou gere um evento. É necessário webhookDestination para observar as duas entregas. O histórico de ocorrências terá apenas uma ocorrência para cada evento gerado.

Forçar 429:

```sh
curl -X PATCH "$BASE_URL/admin/providers/delivery-a/config" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"scenario":"RATE_LIMIT","rateLimit":{"includeRetryAfter":true}}'
```

Testar quota real de 10 requisições por 60 segundos:

```sh
curl -X PATCH "$BASE_URL/admin/providers/delivery-a/config" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"scenario":"NORMAL","rateLimit":{"enabled":true,"requests":10,"windowSeconds":60,"includeRetryAfter":true}}'
```

O limitador conta requisições autenticadas da API Delivery A numa janela fixa compartilhada pelo provider, independentemente do endpoint. Quota esgotada retorna Retry-After em segundos até o fim da janela. No cenário forçado, retorna a duração configurada da janela. Se includeRetryAfter for false, o header é omitido. Alterar rateLimit zera a janela.

Latência:

```sh
curl -X PATCH "$BASE_URL/admin/providers/delivery-a/config" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"scenario":"NORMAL","latencyMs":1000}'
```

## Configuração padrão

```json
{
  "scenario": "NORMAL",
  "latencyMs": 0,
  "errorRate": 1,
  "timeoutDelayMs": 10000,
  "rateLimit": { "enabled": false, "requests": 10, "windowSeconds": 60, "includeRetryAfter": true },
  "webhookDestination": null,
  "webhookRetries": 0,
  "webhookRetryDelayMs": 500,
  "webhookTimeoutMs": 3000
}
```

PATCH é parcial, inclusive dentro de rateLimit. Campos desconhecidos ou valores inválidos retornam 400 sem modificar a configuração. Limites: latencyMs até 60000; timeoutDelayMs até 120000; webhookRetries até 10; webhookTimeoutMs de 1 a 60000; webhookRetryDelayMs até 60000.

## Reset e persistência

```sh
curl -X POST "$BASE_URL/admin/providers/delivery-a/reset" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Localmente, armazenamento em memória simplifica o laboratório. Reset ou reinício local restaura configuração e os dois pedidos iniciais, remove pedidos gerados, eventos, tentativas e quota. Na Vercel, reinícios de funções preservam o estado no Redis; somente reset ou exclusão do Redis restaura os dados. Reset cancela envios e retries locais pendentes e remove a fila persistida. Um envio de outra função já em andamento pode terminar, mas não pode recriar histórico ou retries após reset. Uma requisição atrasada que atravessar um reset retorna 409 sem recriar dados. Um webhook já recebido por outro serviço não pode ser desfeito pelo reset.

Limites por instância: 10000 pedidos, 10000 ocorrências, 1000 entregas pendentes. Ao atingir capacidade, o laboratório retorna 409, permitindo aguardar entregas ou resetar. As últimas 10000 tentativas ficam disponíveis para inspeção; logs completos seguem para stdout em JSON via Pino. Logs não imprimem tokens nem corpos de clientes. Reset não apaga logs já enviados ao stdout ou retidos pela plataforma.

Os registros são observabilidade exclusiva do Mock Server. Não representam a futura observabilidade do Hub.

## Vercel: publicação

O projeto inclui `api/index.ts` e `vercel.json`. É uma API: abrir a raiz no navegador não apresenta uma interface. Para conferir a aplicação publicada, acesse `/health`.

1. Coloque este diretório em um repositório independente chamado `pop9-mock-server` e importe-o na Vercel. Como alternativa, use o CLI oficial da Vercel a partir deste diretório.
2. Use preset **Other** e Node.js **24.x**. O build é `npm run build`, e o diretório estático é `public`, ambos definidos no arquivo de configuração. Ative **Fluid Compute** para o limite de 300 segundos configurado para a função.
3. Crie um **Redis Upstash exclusivo deste laboratório**, pelo Marketplace/Storage da Vercel ou no painel Upstash. Não selecione armazenamento existente do ERP ou Hub. Selecione uma opção sem cobrança somente se disponível e compatível com sua conta/uso; esta configuração não contrata um plano pago automaticamente.
4. Configure as variáveis abaixo no projeto Vercel, usando o token REST de escrita do Redis. Não envie senhas nem tokens por chat ou Git.
5. Publique e confirme `/health`, `/admin/providers` com token administrativo e `/delivery-a/orders` com token Delivery A.

| Variável | Valor |
| --- | --- |
| ADMIN_TOKEN | Token aleatório do administrador |
| DELIVERY_A_TOKEN | Outro token aleatório, diferente do administrativo |
| UPSTASH_REDIS_REST_URL | URL HTTPS REST do Redis exclusivo |
| UPSTASH_REDIS_REST_TOKEN | Token REST de leitura/escrita desse Redis |
| LAB_REDIS_KEY | Opcional; padrão `pop9-mock-server:v1:delivery-a` |

Use instâncias ou chaves distintas para produção e previews do laboratório, evitando que um reset de preview apague testes do ambiente publicado. E-mail e login no navegador do usuário não dão acesso automático a este workspace. Publicar por aqui exige uma conexão autenticada própria; os comandos abaixo também podem ser executados no computador em que você estiver autenticado.

```sh
vercel login
vercel
vercel --prod
```

### Persistência e retries na Vercel

Configuração, pedidos, eventos, quota, tentativas e fila ficam num único snapshot versionado no Redis. Escritas usam comparação e troca atômica (CAS via Lua): invocações concorrentes não sobrescrevem alterações silenciosamente. Pedidos e ocorrências são confirmados antes de iniciar qualquer entrega. Há limite adicional de **4 MiB** no snapshot para manter esta solução pequena; ao atingir o limite, reset é necessário.

Depois de uma chamada bem-sucedida, `waitUntil` processa entregas por até 90 segundos, sem atrasar a resposta. Um retry adiado mantém payload e horário original da ocorrência, e persiste `dueAt` separadamente. O limite de cada execução é finito: configurações muito lentas podem precisar de mais de uma chamada para concluir a fila.

Se uma função for interrompida, o job permanece no Redis. Depois de expirar a reserva, outra chamada pode reentregá-lo com o mesmo eventId. O resultado da tentativa interrompida é registrado como desconhecido/falha quando o job é recuperado. O receptor pode ter recebido o primeiro envio: a garantia é **pelo menos uma vez**, nunca exatamente uma vez. Essa redelivery faz parte do simulador e não muda a ocorrência.

Sem tráfego, não há worker permanente. A fila é retomada por novas chamadas bem-sucedidas ou pelo endpoint administrativo:

```sh
curl -X POST "$BASE_URL/admin/providers/delivery-a/webhooks/dispatch" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Esse endpoint aguarda o processamento de um lote e informa `attemptsProcessed`. Para testes com muitos retries, o executor do teste pode chamá-lo novamente. Não foi configurado cron frequente: o plano Hobby limita cron a uma execução diária, inadequada para retries curtos. Referências: [duração das funções](https://vercel.com/docs/functions/configuring-functions/duration), [cron no Hobby](https://vercel.com/docs/cron-jobs/usage-and-pricing) e [Redis REST](https://upstash.com/docs/redis/features/restapi).

`/health` confirma a configuração necessária e o processo, sem executar consulta ao Redis. Teste `/admin/providers` para verificar também conectividade com a persistência. Falhas de persistência retornam 503, sem cair silenciosamente em memória.

## Alternativa: Railway ou Render

O projeto inclui Dockerfile, lockfile e railway.json. Publicação requer autenticação na conta Railway; e-mail sozinho não concede acesso.

1. Crie um projeto/serviço independente chamado pop9-mock-server.
2. Conecte um repositório que contenha este projeto. Se estiver numa subpasta, configure Root Directory para `/pop9-mock-server`.
3. Configure `ADMIN_TOKEN` e `DELIVERY_A_TOKEN` com valores aleatórios diferentes. Não os coloque no Git.
4. O Dockerfile configura `NODE_ENV=production` e `HOST=0.0.0.0`. PORT vem da plataforma; se não for fornecida, será 3000.
5. Publique, gere o domínio HTTPS do serviço e confirme `GET /health`.
6. Use os tokens para testar as APIs. Configure webhookDestination para o receptor de testes desejado.

Mantenha **uma réplica**, desative suspensão/serverless do serviço se oferecida e evite duas instâncias ativas durante atualizações: o estado é local a cada processo. Reinícios, atualizações e falhas descartam memória. Não há recuperação durável de entregas nesta versão. Não compartilhe serviço, banco ou volumes com ERP/Hub.

Alternativa via CLI, depois de instalar o CLI oficial e autenticar:

```sh
railway login
railway link
railway up
```

Selecione o projeto/serviço exclusivo antes de executar railway up. A aplicação também pode rodar como Web Service Docker no Render: use os mesmos tokens, uma instância ativa, domínio HTTPS e health check `/health`. Não depende de APIs específicas da hospedagem.

## Testes

Vitest com instâncias isoladas e Fastify.inject para a API. O dispatcher é testado contra receptores HTTP locais que capturam os bytes recebidos e simulam erros/timeout. Cobertura inclui os 12 casos mínimos solicitados, cálculos monetários, snapshots imutáveis, redelivery manual, validação, probabilidade de cenários, expiração de quota, autenticação separada e reset durante operações pendentes.

Os testes serverless usam um repositório de teste com CAS e invocações separadas para verificar cold starts, concorrência, quota compartilhada, fila persistida, leases, retries e reset. A função Vercel é exercitada via HTTP local, com o protocolo Redis REST simulado. A integração com Redis/Vercel reais depende das credenciais do ambiente publicado.
