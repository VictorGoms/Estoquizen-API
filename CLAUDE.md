# Estoquizen — API (Backend)

## Visão geral do projeto
SaaS de gestão de estoque multi-tenant. O backend é uma API REST que serve o frontend Next.js em `../estoquizen-frontend`. Autenticação e banco de dados via Supabase (Postgres). Sem ORM — queries diretas com `@supabase/supabase-js`.

## Stack
- Runtime: Node.js + TypeScript (ESM, `"module": "NodeNext"`)
- Framework: Fastify v4
- Banco: Supabase (Postgres) — sem Prisma, sem ORM
- Validação: Zod (sempre antes de tocar o banco)
- Auth: Supabase Auth (JWT verificado via `supabaseAdmin.auth.getUser`)
- Email: nodemailer (Gmail SMTP) — para convites de usuários já cadastrados
- Docs: Swagger UI em `/docs` (via `@fastify/swagger` + `@fastify/swagger-ui`)

## Portas
- API: `http://localhost:3001`
- Frontend: `http://localhost:3000` (pasta `../estoquizen-frontend`)
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
    plans.ts             — PLAN_LIMITS (basic/intermediate/pro) + getLimits() + dailyInvites
    nfce.ts              — consultarNfce(chave) — faz scraping/consulta da SEFAZ
    mailer.ts            — sendWorkspaceInviteEmail() via nodemailer/Gmail SMTP
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
- `GET  /members?workspace_id=xxx` — lista membros com perfil (usa supabaseAdmin + dois selects separados, pois não há FK entre workspace_members.user_id e profiles.id que o PostgREST aceite)
- `POST /members/invite` — convida membro com lógica diferente por tipo de usuário:
  - **Usuário novo**: cria conta via `inviteUserByEmail`, envia email de convite Supabase, status=pendente
  - **Usuário não confirmado** (convidado mas nunca clicou no link): deleta conta antiga e re-convida
  - **Usuário confirmado** (já tem conta ativa): gera magic link via `generateLink`, envia email customizado via nodemailer, status=pendente — ao clicar vai para `/aceitar-convite`
  - Valida limite do plano (ativo + pendente contam juntos)
  - Valida limite diário de convites por workspace (basic=10, growth=25, pro=50)
- `POST /members/accept` — usuário autenticado aceita convite pendente (`{ workspace_id }` → status=ativo)
- `PATCH /members/:id` — atualiza role/status/perfil
- `DELETE /members/:id/invite?workspace_id=xxx` — revoga convite pendente; se nunca logou, deleta a conta também
- `DELETE /members/:id?workspace_id=xxx` — remove membro ativo do workspace

### NFC-e — `src/routes/v1/nfe.ts`
- `POST /nfe/consultar` — recebe `{ tipo: "nfce", chave: "44 dígitos" }` e retorna lista de itens (`{ chave, total_itens, itens[] }`)

## Planos — `src/lib/plans.ts`
```
basic        → R$39/mês  → 150 produtos, 3 membros,  10 convites/dia
intermediate → R$69/mês  → 500 produtos, 7 membros,  25 convites/dia  (label: "Growth")
pro          → R$129/mês → 2000 produtos, 12 membros, 50 convites/dia
```
Limites verificados no servidor em `POST /products` e `POST /members/invite`.

## Tabelas do Supabase
- `workspaces`        — id, name, description, plan, created_by, created_at, updated_at
- `workspace_members` — workspace_id, user_id, role (owner/admin/member), status (ativo/pendente), invited_by, created_at
- `profiles`          — id (= auth.uid), name, email, phone, avatar_color
- `products`          — id, workspace_id, name, code (NOT NULL), category, unit, price, qty, min_qty, max_qty, location, supplier, image_url, nota_fiscal, created_by, created_at, updated_at
- `movements`         — id, product_id, delta, reason, created_by, created_at

### RPCs (funções Postgres)
- `adjust_product_qty(p_product_id, p_delta, p_reason, p_user_id)` — ajuste atômico de estoque + insert em movements
- `accept_workspace_invite()` — chamada pelo frontend em `/set-password` após definir senha; atualiza workspace_members.status para 'ativo'
- `email_exists(p_email text) → boolean` — verifica se email existe em auth.users (usado no forgot-password)
- `create_workspace(p_name text, p_plan text) → json` — **TEMPORÁRIA**, ver nota abaixo

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
Copiar `.env.example` → `.env` e preencher:

```
PORT=3001
NODE_ENV=development
SUPABASE_URL=https://SEU_PROJETO.supabase.co
SUPABASE_ANON_KEY=sua_anon_key_aqui
SUPABASE_SERVICE_ROLE_KEY=sua_service_role_key_aqui   # NUNCA expor no frontend
ALLOWED_ORIGINS=http://localhost:3000

# Gmail SMTP — mesmo email/app-password configurado no Supabase
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=seu@gmail.com
SMTP_PASS=sua_app_password_16_chars
```

## Frontend (../estoquizen-frontend)
- Next.js App Router + TypeScript
- Usa proxy rewrite (`/api/v1/:path*` → `http://localhost:3001/api/v1/:path*`) para evitar mixed-content e CORS
- `.env.local` do frontend tem `NEXT_PUBLIC_API_URL=/api/v1` (relativo)
- Para acesso via rede local (celular/outro PC): `NEXT_PUBLIC_API_URL=/api/v1` continua funcionando pelo proxy
- HTTPS local: `next dev --experimental-https` com certificado mkcert (necessário para câmera em rede local)
- `reactStrictMode: false` no `next.config.ts` (evita double-mount que quebrava o BarcodeScanner)

### Páginas de auth do frontend
- `/login` — login email+senha + Google OAuth; erros em português
- `/forgot-password` — verifica se email existe via RPC `email_exists`, envia reset via `resetPasswordForEmail` com `redirectTo=/reset-password`, cooldown 60s
- `/reset-password` — se tiver `?code=` na URL chama `exchangeCodeForSession(code)` antes de mostrar o form; chama `supabase.auth.updateUser({ password })`
- `/auth/callback` — ponto de redirect do Supabase para OAuth (Google) e convites de novos usuários; chama `exchangeCodeForSession(code)` e redireciona com base em `from_invite` no user_metadata
- `/set-password` — tela de definir senha para usuários **recém convidados** (novos no sistema); chama RPC `accept_workspace_invite` após definir senha
- `/aceitar-convite?workspace_id=xxx` — tela de aceite para usuários **já cadastrados** que foram convidados; troca o `?code=` da magic link, exibe nome do workspace, chama `POST /members/accept`
- `/convite-invalido` — tela de erro quando convite não existe ou foi revogado

### Context de usuário — `src/lib/userContext.tsx`
- `UserProvider` envolve todas as páginas protegidas (via `SessionGuardWrapper`)
- Expõe `useUser()` → `{ userName, userEmail, avatarUrl }`
- Faz fetch do perfil uma vez por sessão e cacheia em `sessionStorage` (evita flicker de ícone/nome ao navegar)
- `clearSession()` em `src/lib/session.ts` também limpa o cache do sessionStorage

### Paths públicos (SessionGuardWrapper)
```
/ /login /register /register-company /plan-selection
/auth/callback /forgot-password /reset-password
/convite-invalido /set-password /aceitar-convite
```

## Decisões importantes já tomadas

- **Sem ORM**: queries diretas com supabase-js para simplicidade e controle de RLS
- **RLS pelo token**: `supabaseForUser(token)` cria client autenticado que respeita as policies da tabela; operações admin usam `supabaseAdmin` explicitamente
- **code auto-gerado**: produtos sem código (vindos de NFC-e) recebem `AUTO-XXXXXXXX` para satisfazer NOT NULL
- **Estoque atômico**: ajuste via RPC Postgres evita race condition em ambientes com múltiplos usuários simultâneos
- **Stats via join**: movements não tem workspace_id; join com products (`products!inner(workspace_id)`) é necessário para contar movimentações por workspace
- **GET /members usa dois selects**: PostgREST não aceita join `profiles(...)` pois não há FK explícita entre `workspace_members.user_id` e `profiles.id` — solução é buscar members e profiles separadamente e fazer merge no código
- **Invite flow separado por tipo de usuário**: novo → `inviteUserByEmail` (Supabase envia email); não-confirmado → deleta + re-convida; confirmado → `generateLink` + nodemailer (email customizado com magic link)
- **PKCE flow**: Supabase usa `?code=` na URL (não hash `#type=recovery`). Sempre usar `exchangeCodeForSession(code)` explicitamente. O `onAuthStateChange` sozinho não é suficiente
- **Reset password sem passar pelo /auth/callback**: `redirectTo` do `resetPasswordForEmail` aponta direto para `/reset-password`, que troca o code ele mesmo. Evita conflito com `from_invite` no user_metadata de usuários que foram convidados antes
- **Gmail SMTP**: Supabase configurado com Gmail SMTP (500 emails/dia). Mesmo app-password usado nas vars SMTP_PASS da API Railway

---

## Sistema de Assinaturas — Decisões de Arquitetura (a implementar)

> Esta seção documenta todas as decisões tomadas em debate. Nada foi implementado ainda.

### Plataforma
- **Stripe** (não AbacatePay)
- Usar **modo test** do Stripe durante desenvolvimento — cartões de teste não cobram nada
- Stripe CLI para receber webhooks localmente: `stripe listen --forward-to localhost:3001/webhooks/stripe`

### Modelo de cobrança
- **Por workspace** (não por usuário) — 1 workspace = 1 assinatura = 1 Stripe Customer
- Se o usuário tiver múltiplos workspaces, cada um tem sua própria assinatura independente

### Nomes dos planos (BREAKING CHANGE em relação ao código atual)
| Slug no banco | Label | Preço | Produtos | Membros |
|---|---|---|---|---|
| `basic` | Basic | R$19,90/mês | 50 | 3 |
| `growth` | Growth | R$29,90/mês | 300 | 7 |
| `pro` | Pro | R$59,90/mês | 2000 | 12 |

**ATENÇÃO**: o slug `intermediate` que existe hoje no banco e em `plans.ts` deve ser renomeado para `growth` em toda a codebase. Isso inclui:
- `database/schema.sql` — check constraint na tabela `workspaces`
- `src/lib/plans.ts` — chave do objeto `PLAN_LIMITS`
- Supabase Dashboard — alterar o check constraint via migration SQL

### Modelo de trial (sem cartão upfront)
- Usuário escolhe plano → cria workspace → **trial começa sem pedir cartão**
- O Stripe **não é criado ainda** durante o trial — a assinatura é puramente local no banco
- O Stripe só entra quando o usuário decide pagar

**Duração do trial:**
- Workspaces criados até **2026-06-30**: 30 dias (early users)
- Workspaces criados após **2026-06-30**: 14 dias
- Lógica: `const trialDays = workspace.created_at < new Date("2026-06-30") ? 30 : 14`

### Timeline após expiração do trial
```
Dia 0          → workspace criado, status = "trialing"
Dia 14 (ou 30) → trial expira → status = "trial_expired"
               → email enviado: "seu acesso foi limitado, adicione um cartão"
               → usuário pode VER dados mas NÃO pode criar/editar
               → botão "exportar CSV" disponível (evita reclamação de dado perdido)
Dia 28 (ou 44) → +14 dias sem pagar → email de aviso final
               → "seu workspace será deletado em 16 dias"
Dia 44 (ou 60) → +30 dias sem pagar → workspace deletado por job agendado
```

### Status da assinatura (campo `subscriptions.status`)
| Status | Significado | Acesso |
|---|---|---|
| `trialing` | Trial ativo | Total |
| `trial_expired` | Trial acabou, sem pagamento | Só leitura + exportação |
| `active` | Pagando, assinatura ativa | Total |
| `past_due` | Pagamento falhou, Stripe ainda tentando | Total (Stripe retenta ~7 dias) |
| `canceled` | Cancelou ou Stripe desistiu | Só leitura + exportação |
| `deleted` | Marcado para deleção (job ainda não rodou) | Bloqueado |

### Tabela `subscriptions` (nova — adicionar ao schema)
```sql
create table if not exists public.subscriptions (
  id                     uuid primary key default uuid_generate_v4(),
  workspace_id           uuid not null references public.workspaces(id) on delete cascade,
  plan                   text not null check (plan in ('basic', 'growth', 'pro')),
  status                 text not null default 'trialing'
                           check (status in ('trialing','trial_expired','active','past_due','canceled','deleted')),
  trial_ends_at          timestamptz,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,
  stripe_customer_id     text,
  stripe_subscription_id text,
  stripe_price_id        text,
  created_at             timestamptz default now(),
  updated_at             timestamptz default now(),
  unique (workspace_id)   -- 1 assinatura por workspace
);
```

### Sincronização `subscriptions` ↔ `workspaces.plan`
- `workspaces.plan` é mantido como **cache** da assinatura ativa
- O código existente que lê `workspaces.plan` para checar limites **não precisa mudar**
- Quando o webhook do Stripe atualiza `subscriptions`, ele também atualiza `workspaces.plan` na mesma operação

### Stripe metadata (obrigatório ao criar Customer e Subscription)
Sempre passar nos dois objetos do Stripe:
```typescript
metadata: {
  workspace_id: "uuid-do-workspace",
  plan: "growth"  // ou basic | pro
}
```
Isso permite identificar o workspace diretamente no payload do webhook, sem query extra.

Também configurar nos Products/Prices do Stripe Dashboard:
```
Price metadata: { plan: "growth", interval: "monthly" }
```

### Rotas de billing (novas — `src/routes/v1/billing.ts`)
```
POST /billing/checkout          — cria Stripe Checkout Session (redireciona para pagar)
POST /billing/portal            — cria Customer Portal Session (gerenciar assinatura)
POST /billing/cancel            — define cancel_at_period_end = true (não cancela imediato)
POST /billing/upgrade           — troca de plano (Stripe faz prorata automático)
GET  /billing/subscription      — retorna estado atual da assinatura do workspace
POST /webhooks/stripe           — recebe eventos do Stripe
```

**CRÍTICO no webhook:**
- Rota `/webhooks/stripe` **NÃO tem** `preHandler: [fastify.authenticate]` — o Stripe não envia JWT
- Validar assinatura com `stripe.webhooks.constructEvent(rawBody, stripeSignatureHeader, STRIPE_WEBHOOK_SECRET)`
- O `rawBody` deve ser o body **bruto** (antes do parse JSON) — Fastify tem hook `addContentTypeParser` para isso
- **Nunca ativar assinatura pela success URL do Checkout** — sempre pelo webhook `invoice.paid`

### Webhooks do Stripe a ouvir
| Evento | Ação no backend |
|---|---|
| `invoice.paid` | `status = active`, atualiza `current_period_end`, atualiza `workspaces.plan` |
| `invoice.payment_failed` | `status = past_due` (não bloqueia ainda — Stripe vai retentar) |
| `customer.subscription.updated` | Atualiza `plan`, `status`, `cancel_at_period_end`, `stripe_price_id` |
| `customer.subscription.deleted` | `status = canceled` — acesso limitado a leitura |

### Grace period após falha de pagamento
- **Delegar ao Stripe Smart Retries** (configurar no Stripe Dashboard: 3 tentativas em ~7 dias)
- Backend só bloqueia quando `status = canceled` ou `status = unpaid` (Stripe desistiu)
- Nunca bloquear imediatamente em `past_due`

### Cancelamento
- Usuário cancela → `cancel_at_period_end = true` (não cancela imediato)
- Continua com acesso até o fim do ciclo pago
- No fim do ciclo, Stripe emite `customer.subscription.deleted` → webhook muda para `status = canceled`

### Job agendado (deleção de workspaces)
- Roda **diariamente**
- Busca workspaces com `subscriptions.status IN ('trial_expired', 'canceled')` E `updated_at < now() - interval '30 days'`
- Envia email de aviso 16 dias antes de deletar
- Pode ser implementado como: cron no servidor, Supabase Edge Function agendada, ou pg_cron

### Variáveis de ambiente adicionais (a acrescentar no `.env`)
```
STRIPE_SECRET_KEY=sk_test_...          # chave secreta do Stripe (test mode)
STRIPE_WEBHOOK_SECRET=whsec_...        # obtido com: stripe listen --forward-to ...
STRIPE_PRICE_BASIC=price_...           # ID do Price no Stripe Dashboard
STRIPE_PRICE_GROWTH=price_...
STRIPE_PRICE_PRO=price_...
```

### Ordem de implementação recomendada
1. Renomear `intermediate` → `growth` no banco e em `plans.ts`
2. Criar tabela `subscriptions` no Supabase
3. Alterar `POST /workspaces` para inserir em `subscriptions` com `status=trialing` ao criar workspace
4. Criar middleware de verificação de assinatura (lê `subscriptions.status` antes de rotas mutáveis)
5. Instalar `stripe` npm package
6. Criar `src/lib/stripe.ts` com o client Stripe
7. Criar `src/routes/v1/billing.ts` com as rotas de billing
8. Implementar o webhook `/webhooks/stripe` com validação de assinatura
9. Implementar o job de deleção de workspaces expirados

### ⚠️ Políticas RLS temporárias — remover ao implementar billing

As políticas abaixo foram adicionadas **temporariamente** para permitir criação de workspace
direto pelo frontend (sem Railway) enquanto o sistema de pagamento não existe.

**Quando implementar o Stripe (passo 3 acima), estas políticas devem ser removidas**,
pois a criação de workspace voltará a passar pelo Railway (`POST /workspaces`), que cria
o registro de trial em `subscriptions`. Manter as políticas seria um risco: qualquer
usuário autenticado poderia criar workspace sem passar pelo billing.

SQL para remover quando chegar a hora:
```sql
drop policy if exists "Usuário autenticado cria workspace" on public.workspaces;
drop policy if exists "Criador adiciona-se como owner"     on public.workspace_members;
```

E revertir `src/app/plan-selection/page.tsx` do frontend para usar `api.post("/workspaces", ...)`
em vez das chamadas diretas ao Supabase.

### ⚠️ RPC `create_workspace` — também remover ao implementar billing

Durante os testes descobrimos que INSERT direto via PostgREST retorna 403 mesmo com JWT válido
e políticas RLS corretas (comportamento inconsistente do Supabase com ES256 + RLS + INSERT).
A solução foi criar uma função Postgres `SECURITY DEFINER`:

```sql
-- Função temporária — criada em 2026-04-18, remover quando criar workspace voltar ao Railway
create or replace function public.create_workspace(p_name text, p_plan text)
returns json language plpgsql security definer set search_path = public as $$
declare v_user_id uuid; v_workspace public.workspaces;
begin
  v_user_id := auth.uid();
  if v_user_id is null then raise exception 'Not authenticated'; end if;
  insert into public.workspaces (name, plan, created_by) values (p_name, p_plan, v_user_id) returning * into v_workspace;
  insert into public.workspace_members (workspace_id, user_id, role, status) values (v_workspace.id, v_user_id, 'owner', 'ativo');
  return row_to_json(v_workspace);
end; $$;
```

O frontend chama via `supabase.rpc("create_workspace", { p_name, p_plan })`.

**Quando implementar o Stripe**, a criação de workspace volta para o Railway (`POST /workspaces`),
que também vai inserir em `subscriptions`. Nesse momento:
1. Remover a função `create_workspace` do Supabase: `drop function public.create_workspace(text, text);`
2. Revertir `plan-selection/page.tsx` para `api.post("/workspaces", ...)`
3. Remover as políticas RLS temporárias listadas acima

### ✅ RPC `invite_member` — substituída pela rota da API

O convite de membros passou a ser gerenciado inteiramente pela rota `POST /members/invite` no Railway,
que trata os três casos (novo, não-confirmado, confirmado) e envia emails via nodemailer quando necessário.
Não há mais dependência de Edge Function ou RPC para o fluxo de convite.

### ✅ RPCs permanentes no Supabase
- `accept_workspace_invite()` — chamada pelo frontend em `/set-password` após definir senha
- `email_exists(p_email)` — chamada pelo frontend em `/forgot-password` para verificar cadastro
- `adjust_product_qty(...)` — ajuste atômico de estoque
