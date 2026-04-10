# Estoquizen — API (Backend)

## Visão geral do projeto
SaaS de gestão de estoque multi-tenant. O backend é uma API REST que serve o frontend Next.js em `../TesteFrontSaas`. Autenticação e banco de dados via Supabase (Postgres). Sem ORM — queries diretas com `@supabase/supabase-js`.

## Stack
- Runtime: Node.js + TypeScript (ESM, `"module": "NodeNext"`)
- Framework: Fastify v4
- Banco: Supabase (Postgres) — sem Prisma, sem ORM
- Validação: Zod (sempre antes de tocar o banco)
- Auth: Supabase Auth (JWT verificado via `supabaseAdmin.auth.getUser`)
- Docs: Swagger UI em `/docs` (via `@fastify/swagger` + `@fastify/swagger-ui`)

## Portas
- API: `http://localhost:3001`
- Frontend: `http://localhost:3000` (pasta `../TesteFrontSaas`)
- Docs: `http://localhost:3001/docs`

## Estrutura de pastas
```
src/
  server.ts              — bootstrap Fastify, CORS, helmet, rate limit, swagger
  plugins/auth.ts        — verifica JWT, injeta req.user
  routes/v1/
    index.ts             — registra todas as rotas em /api/v1
    products.ts          — CRUD + ajuste de estoque + movimentações
    workspaces.ts        — CRUD de workspaces + stats do dashboard
    members.ts           — convite e gestão de membros
    nfe.ts               — consulta NFC-e por chave (44 dígitos)
  schemas/
    product.schema.ts    — CreateProductSchema, UpdateProductSchema, AdjustQtySchema
    workspace.schema.ts  — CreateWorkspaceSchema, UpdateWorkspaceSchema
    member.schema.ts     — InviteMemberSchema, UpdateMemberSchema
  lib/
    supabase.ts          — supabaseAdmin + supabaseForUser(token)
    response.ts          — ok(), fail(), dbError() helpers
    sanitize.ts          — sanitizeText, sanitizeCode, sanitizeNumber, sanitizeEmail
    plans.ts             — PLAN_LIMITS (basic/intermediate/pro) + getLimits()
    nfce.ts              — consultarNfce(chave) — faz scraping/consulta da SEFAZ
  types/index.ts         — ApiResponse<T>, augment FastifyRequest (req.user)
database/
  schema.sql             — schema completo do Postgres (aplicar no Supabase SQL Editor)
  seed.sql               — dados de teste (opcional)
```

## Padrões obrigatórios
- Toda resposta usa `{ data, error }` via `ok()` / `fail()` (nunca retornar estrutura diferente)
- Rotas protegidas: `{ preHandler: [fastify.authenticate] }`
- Rotas que respeitam RLS: usar `supabaseForUser(token)` — NÃO supabaseAdmin
- Rotas privilegiadas (criar workspace, convidar usuário): usar `supabaseAdmin`
- Validação de body sempre com Zod antes de tocar o banco
- Erros do banco sempre passam por `dbError()` antes de ir ao cliente (evita vazar nomes de tabelas/constraints)

## Auth flow
1. Cliente faz login via Supabase Auth (frontend/mobile)
2. Recebe `access_token` (JWT)
3. Envia em toda requisição: `Authorization: Bearer <token>`
4. Fastify verifica com `supabaseAdmin.auth.getUser(token)`
5. `req.user` fica disponível na rota

## Rotas implementadas

### Produtos — `src/routes/v1/products.ts`
- `GET  /products?workspace_id=xxx` — lista produtos do workspace (usa RLS)
- `GET  /products/:id` — detalhe do produto
- `POST /products` — cria produto; valida limite do plano; `code` é gerado automaticamente (`AUTO-XXXXXXXX`) se não informado (evita NOT NULL constraint para produtos importados via NFC-e)
- `PATCH /products/:id` — atualiza produto
- `DELETE /products/:id` — remove produto (RLS exige owner/admin)
- `POST /products/:id/adjust` — entrada/saída de estoque via RPC `adjust_product_qty` (atômico)
- `GET  /products/:id/movements?since=<iso>&limit=<n>` — histórico de movimentações

### Workspaces — `src/routes/v1/workspaces.ts`
- `GET  /workspaces` — workspaces do usuário autenticado (via RLS)
- `GET  /workspaces/:id/stats` — contadores para dashboard: `{ produtos, alertas, movimentacoes }` — alertas = produtos com qty < 10
- `POST /workspaces` — cria workspace e adiciona criador como owner (usa supabaseAdmin)
- `PATCH /workspaces/:id` — atualiza workspace
- `DELETE /workspaces/:id` — exclui workspace (apenas owner); cascata apaga members, products e movements via FK

### Membros — `src/routes/v1/members.ts`
- `GET  /members?workspace_id=xxx` — lista membros com perfil
- `POST /members/invite` — convida membro: se já tem conta adiciona direto; se não, envia email de convite via Supabase Admin; valida limite do plano
- `PATCH /members/:id` — atualiza role/status/perfil
- `DELETE /members/:id?workspace_id=xxx` — remove do workspace

### NFC-e — `src/routes/v1/nfe.ts`
- `POST /nfe/consultar` — recebe `{ tipo: "nfce", chave: "44 dígitos" }` e retorna lista de itens (`{ chave, total_itens, itens[] }`)

## Planos — `src/lib/plans.ts`
```
basic        → R$39/mês  → 150 produtos, 3 membros
intermediate → R$69/mês  → 500 produtos, 7 membros  (label: "Growth")
pro          → R$129/mês → 2000 produtos, 12 membros
```
Limites verificados no servidor em `POST /products` e `POST /members/invite`.

## Tabelas do Supabase
- `workspaces`        — id, name, description, plan, created_by, created_at, updated_at
- `workspace_members` — workspace_id, user_id, role (owner/admin/member), status (ativo/pendente), invited_by, created_at
- `profiles`          — id (= auth.uid), name, email, phone, avatar_color
- `products`          — id, workspace_id, name, code (NOT NULL), category, unit, price, qty, min_qty, max_qty, location, supplier, image_url, nota_fiscal, created_by, created_at, updated_at
- `movements`         — id, product_id, delta, reason, created_by, created_at

### RPC (função Postgres)
- `adjust_product_qty(p_product_id, p_delta, p_reason, p_user_id)` — ajuste atômico de estoque + insert em movements

## Rate limiting (server.ts)
- Global: 200 req/min por usuário (userId do JWT) ou IP como fallback
- Criação de workspace/invite: 10 req/min (authStrict)
- Mutações em geral: 60 req/min (authWrite)

## Segurança
- `@fastify/helmet` — headers HTTP de segurança
- `@fastify/cors` — origens controladas por `ALLOWED_ORIGINS` no `.env`
- `@fastify/rate-limit` — proteção contra brute force e abuso
- `dbError()` — sanitiza erros do banco (impede vazamento de schema interno)
- `sanitize.ts` — funções de sanitização por tipo (text, code, number, email)

## Banco de dados
Schema completo em `database/schema.sql`.
Para aplicar: Supabase Dashboard → SQL Editor → colar o arquivo → Run.

## Variáveis de ambiente
Copiar `.env.example` → `.env` e preencher com dados do Supabase Dashboard → Settings → API

```
PORT=3001
NODE_ENV=development
SUPABASE_URL=https://SEU_PROJETO.supabase.co
SUPABASE_ANON_KEY=sua_anon_key_aqui
SUPABASE_SERVICE_ROLE_KEY=sua_service_role_key_aqui   # NUNCA expor no frontend
ALLOWED_ORIGINS=http://localhost:3000
```

## Frontend (../TesteFrontSaas)
- Next.js App Router + TypeScript
- Usa proxy rewrite (`/api/v1/:path*` → `http://localhost:3001/api/v1/:path*`) para evitar mixed-content e CORS
- `.env.local` do frontend tem `NEXT_PUBLIC_API_URL=/api/v1` (relativo)
- Para acesso via rede local (celular/outro PC): `NEXT_PUBLIC_API_URL=/api/v1` continua funcionando pelo proxy
- HTTPS local: `next dev --experimental-https` com certificado mkcert (necessário para câmera em rede local)
- `reactStrictMode: false` no `next.config.ts` (evita double-mount que quebrava o BarcodeScanner)

## Decisions importantes já tomadas
- **Sem ORM**: queries diretas com supabase-js para simplicidade e controle de RLS
- **RLS pelo token**: `supabaseForUser(token)` cria client autenticado que respeita as policies da tabela; operações admin usam `supabaseAdmin` explicitamente
- **code auto-gerado**: produtos sem código (vindos de NFC-e) recebem `AUTO-XXXXXXXX` para satisfazer NOT NULL
- **Estoque atômico**: ajuste via RPC Postgres evita race condition em ambientes com múltiplos usuários simultâneos
- **Stats via join**: movements não tem workspace_id; join com products (`products!inner(workspace_id)`) é necessário para contar movimentações por workspace
