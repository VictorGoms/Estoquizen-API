# Estoquizen — API (Backend)

## Visão geral do projeto
SaaS de gestão de estoque multi-tenant. O backend é uma API REST que serve o frontend Next.js em `../estoquizen-frontend`. Autenticação e banco de dados via Supabase (Postgres). Sem ORM — queries diretas com `@supabase/supabase-js`.

## Stack
- Runtime: Node.js + TypeScript (ESM, `"module": "NodeNext"`)
- Framework: Fastify v5
- Banco: Supabase (Postgres) — sem Prisma, sem ORM
- Validação: Zod (sempre antes de tocar o banco)
- Auth: Supabase Auth (JWT verificado via `supabaseAdmin.auth.getUser`)
- E-mail: convites, confirmação e senha saem pelo Supabase Auth com SMTP do Resend (remetente `noreply@estoquizen.com.br`, domínio verificado); avisos do trial saem pela API do Resend (`src/lib/resend.ts`)
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
    nfe.ts               — consulta NFC-e por chave e importa a nota (transacional)
    billing.ts           — assinatura, checkout e portal do Stripe
  routes/webhooks.ts     — POST /webhooks/stripe (API dahlia)
  routes/admin/cleanup.ts — POST /admin/cleanup (CRON_SECRET)
  schemas/
    product.schema.ts    — CreateProductSchema, UpdateProductSchema (sem qty), AdjustQtySchema
    workspace.schema.ts  — CreateWorkspaceSchema, UpdateWorkspaceSchema
    member.schema.ts     — InviteMemberSchema, UpdateMemberSchema
  lib/
    supabase.ts          — supabaseAdmin + supabaseForUser(token)
    response.ts          — ok(), fail(), dbError(), dbStatus(), sendDbError()
    membership.ts        — requireMember(workspace, user, reply, roles?) — 404 se não é membro, 403 se o papel não basta
    checkSubscription.ts — assertActiveSubscription() (trial vencido bloqueia na hora) + expireTrialIfDue() + getProductWorkspaceId()
    zodPt.ts             — mensagens padrão do Zod em português (importado no server.ts)
    sanitize.ts          — sanitizeText, sanitizeCode, sanitizeNumber, sanitizeEmail, sanitizeCpf
    plans.ts             — PLAN_LIMITS (basic/growth/pro) + getLimits() + dailyInvites
    nfce.ts              — consultarNfce(chave) — faz scraping/consulta da SEFAZ
    stripe.ts            — cliente Stripe (apiVersion 2026-03-25.dahlia) + PRICE_IDS
    resend.ts            — e-mails pelo Resend: assinatura confirmada (webhook) e os do job de limpeza (aviso, último aviso, exclusão); lança erro se o Resend recusar
    emailLayout.ts       — layout dos e-mails no tema "Noite Azul" (tabelas e estilo inline) + escapeHtml; também gera os modelos do Supabase Auth
    cleanup.ts           — job diário de expiração/aviso/exclusão
  types/index.ts         — ApiResponse<T>, augment FastifyRequest (req.user)
supabase/migrations/     — migrações SQL (fonte da verdade do banco; aplicar pelo MCP ou SQL Editor)
supabase/templates/       — modelos dos e-mails do Supabase Auth (confirmação, convite, senha...): colar no painel; ver o README de lá
scripts/email-templates.ts — gera os modelos acima a partir do emailLayout.ts
database/
  schema.sql             — schema antigo (desatualizado; ver supabase/migrations)
  seed.sql               — dados de teste (opcional)
```

## Padrões obrigatórios
- Toda resposta usa `{ data, error }` via `ok()` / `fail()` (nunca retornar estrutura diferente)
- Rotas protegidas: `{ preHandler: [fastify.authenticate] }`
- Rotas que respeitam RLS: usar `supabaseForUser(token)` — NÃO supabaseAdmin
- Rotas privilegiadas (criar workspace, convidar usuário): usar `supabaseAdmin`
- **Rota que usa `supabaseAdmin` (ignora RLS) chama `requireMember()` antes de ler ou gravar** — sem isso qualquer conta acessa qualquer workspace pelo id (SCRUM-42 a 45)
- Validação de body sempre com Zod antes de tocar o banco
- Erro do banco: `return sendDbError(req, reply, error)` — status pelo código do Postgres (23505→409, FK/NOT NULL/CHECK→400, 42501→403), mensagem saneada por `dbError()` e log do original nos 500
- O supabase-js e o SDK do Resend **não lançam exceção**: devolvem `{ error }`. Sempre checar o `error`
- Erros não tratados e rota inexistente já saem como `{ data: null, error }` em português (setErrorHandler/setNotFoundHandler no server.ts)
- **O banco aplica as regras também para quem chama o Supabase direto (SCRUM-48).** O cliente (`authenticated`) não grava `qty`, `movements`, `nota_imports`, `workspaces.plan` nem insere membros; só as colunas liberadas por GRANT (produto: dados cadastrais; workspace: nome/descrição; perfil: nome/telefone/foto; membro: papel/status). Toda escrita exige `workspace_is_writable()` (mesma regra do `assertActiveSubscription`). Coluna nova que o cliente precise gravar = GRANT novo numa migração

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
- `PATCH /products/:id` — atualiza produto (não aceita `qty`: estoque só muda por `/adjust`, que grava a movimentação)
- `DELETE /products/:id` — remove produto (RLS exige owner/admin)
- `POST /products/:id/adjust` — entrada/saída de estoque via RPC `adjust_product_qty` (atômico). `{ delta, reason?, motivo? }`: na saída, `motivo` é venda/perda/vencido/furto/uso_interno/devolucao (padrão venda); na entrada é ignorado
- `POST /products/:id/count` — contagem do dia `{ counted }` (EQZ-17, Growth e Pro) via RPC `register_stock_count`: registra em `stock_counts` e, se não bater, corrige o estoque com "Ajuste de contagem"
- `GET  /products/:id/movements?since=<iso>&limit=<n>` — histórico de movimentações
- `POST /products/import` — importação de planilha (EQZ-14) `{ workspace_id, itens[] }` (até 2000; o front lê o CSV/Excel e manda as colunas já mapeadas). Owner/admin, assinatura ativa, limite do plano. RPC `import_products` grava tudo numa transação; código que já existe no workspace é pulado (`{ criados, ignorados }`) e quantidade > 0 vira "Estoque inicial (planilha)"

### Workspaces — `src/routes/v1/workspaces.ts`
- `GET  /workspaces` — workspaces do usuário autenticado (via RLS)
- `GET  /workspaces/:id/stats` — contadores para dashboard: `{ produtos, alertas, movimentacoes }` — alerta = zerado ou `qty <= min_qty` (mesma regra do `deriveStatus` do front)
- `POST /workspaces` — valida o CPF **antes** de criar; cria workspace, owner e subscription; desfaz tudo se um passo falhar (usa supabaseAdmin)
- `PATCH /workspaces/:id` — atualiza workspace
- `DELETE /workspaces/:id` — exclui workspace (apenas owner); cascata apaga members, products e movements via FK

### Membros — `src/routes/v1/members.ts`
- `GET  /members?workspace_id=xxx` — lista membros com perfil (usa supabaseAdmin + dois selects separados, pois não há FK entre workspace_members.user_id e profiles.id que o PostgREST aceite)
- `POST /members/invite` — só owner/admin (só owner convida owner). Checa duplicidade **antes** de mandar e-mail:
  - **Membro ativo**: 409, sem e-mail
  - **Convite pendente no mesmo workspace**: reenvia o e-mail (200 "Convite reenviado"), atualizando o papel
  - **Usuário novo**: `inviteUserByEmail` (Supabase manda o e-mail), status=pendente
  - **Usuário não confirmado**: atualiza o metadata e reenvia o convite **sem apagar a conta** (apagar levava junto os convites dela em outros workspaces)
  - **Usuário confirmado**: magic link (`signInWithOtp`) para `/aceitar-convite`; se o envio falhar, 500 e nada é gravado
  - Valida limite do plano (ativo + pendente contam juntos; reenvio não ocupa vaga)
  - Limite diário conta os e-mails enviados na tabela `invite_log` (basic=10, growth=25, pro=50), inclusive reenvios e convites revogados
- `POST /members/accept` — usuário autenticado aceita convite pendente (`{ workspace_id }` → status=ativo)
- `PATCH /members/:id?workspace_id=xxx` — atualiza role/status/perfil só naquele workspace (owner/admin; regras de owner na trigger `protect_workspace_owner`)
- `DELETE /members/:id/invite?workspace_id=xxx` — revoga convite pendente; se nunca logou, deleta a conta também
- `DELETE /members/:id?workspace_id=xxx` — remove membro ativo do workspace

### NFC-e — `src/routes/v1/nfe.ts`
- `POST /nfe/consultar` — recebe `{ tipo: "nfce", chave: "44 dígitos", workspace_id }` e retorna lista de itens (`{ chave, total_itens, itens[] }`). Owner/admin e plano com `nfe`
- `POST /nfe/importar` — `{ workspace_id, tipo, chave, itens[] }` (item com `product_id` soma no existente; sem, cria). Owner/admin, assinatura ativa, limite de produtos do plano. RPC `import_nota_fiscal` faz tudo numa transação e recusa a mesma chave no workspace (409 com a data da importação anterior)

## Planos — `src/lib/plans.ts`
```
basic  → R$24,90/mês → 50 produtos,   3 membros,       10 convites/dia, 2 notas/mês,  métricas 30 dias
growth → R$39,90/mês → 300 produtos,  10 membros,      25 convites/dia, notas livres, métricas 3 meses
pro    → R$59,90/mês → 2000 produtos, membros sem limite, 50 convites/dia, notas livres, métricas 12 meses
```
Limites verificados no servidor em `POST /products` e `POST /members/invite`.
Planos fechados pelo João em 2026-10-17 (EQZ-27, substitui o SCRUM-57): equipe 3/10/sem limite, Basic lê até 2 notas de compra por mês (cota conferida em `/nfe/*` e na RPC `import_nota_fiscal`, mês no horário de Brasília) e métricas de 30 dias/3 meses/12 meses (aplicadas no front, `usePlan`). Preços novos (EQZ-11) aplicados em 2026-10-20: Prices novos no Stripe para Basic (R$ 24,90) e Growth (R$ 39,90), os antigos arquivados; assinatura antiga continua no preço dela e o plano vem do `metadata.plan` da assinatura.
O slug `intermediate` foi renomeado para `growth` — constraint e dados já atualizados no Supabase.

## Tabelas do Supabase
- `workspaces`        — id, name, description, plan, created_by, created_at, updated_at
- `workspace_members` — workspace_id, user_id, role (owner/admin/member), status (ativo/pendente), invited_by, created_at
- `profiles`          — id (= auth.uid), name, email, phone, avatar_color, cpf (unique, nullable)
- `products`          — id, workspace_id, name, code (NOT NULL), category, unit, price, cost (custo de compra, opcional; a nota preenche), qty, min_qty, max_qty, location, supplier, image_url (foto da pessoa ou da embalagem no Open Food Facts), icon (EQZ-30: ícone escolhido à mão ou `nenhum`; null = automático pelo nome, no front), nota_fiscal, created_by, created_at, updated_at
- `movements`         — id, product_id, delta, reason (texto livre), motivo (saída: venda/perda/vencido/furto/uso_interno/devolucao/ajuste_contagem; null na entrada), created_by, created_at
- `subscriptions`     — id, workspace_id, plan, status, trial_ends_at, current_period_end, cancel_at_period_end, stripe_customer_id, stripe_subscription_id, stripe_price_id, created_at, updated_at, expired_at, warned_at
- `nota_imports`      — notas importadas: workspace_id, chave (única por workspace), tipo, itens, imported_by, created_at
- `trial_grants`      — trials concedidos: user_id (único), cpf_hash SHA-256 (único), workspace_id, granted_at. RLS sem policies: só a API acessa
- `stock_counts`      — contagens do dia (workspace_id, product_id, counted_by, expected_qty, counted_qty, created_at). Membros leem; só a RPC grava
- `invite_log`        — cada e-mail de convite enviado (workspace_id, invited_by, created_at), para o limite diário. RLS sem policies

Trigger `protect_workspace_owner` (BEFORE UPDATE/DELETE em `workspace_members`): só owner promove alguém a owner ou altera/remove outro owner, e o workspace nunca fica sem owner ativo. Vale também para as escritas diretas do front; o service_role passa direto.

Trigger `on_auth_user_email_changed` (AFTER UPDATE OF email em `auth.users`): copia o e-mail novo para `profiles.email` quando a pessoa confirma a troca de e-mail feita no Perfil (2026-10-20).

Trigger `subscriptions_track_expiry` (BEFORE INSERT/UPDATE OF status em `subscriptions`): grava `expired_at` quando a assinatura expira e limpa `expired_at`/`warned_at` quando ela volta a valer. Base do job de limpeza.

```sql
-- CPF no perfil (rodar no Supabase SQL Editor se ainda não existir)
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS cpf TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS profiles_cpf_unique ON public.profiles (cpf) WHERE cpf IS NOT NULL;
```

### RPCs (funções Postgres)
- `adjust_product_qty(p_product_id, p_delta, p_motivo, p_reason, p_user_id)` — ajuste atômico de estoque + insert em movements com o motivo (EQZ-23; o autor é `auth.uid()`). SECURITY DEFINER: checa membro e `workspace_is_writable` por dentro. A versão antiga sem `p_motivo` continua (o estoque inicial do cadastro usa); como `p_motivo` não tem padrão, não há ambiguidade entre as duas
- `accept_workspace_invite()` — chamada pelo frontend em `/set-password` após definir senha; ativa só um convite **pendente que já existe** (o papel vem do convite, nunca do user_metadata); não aceita anon
- `import_nota_fiscal(p_workspace_id, p_chave, p_tipo, p_itens jsonb)` — importação de nota numa transação (ver `/nfe/importar`). SECURITY DEFINER: checa owner/admin e `workspace_is_writable` por dentro
- `workspace_is_writable(ws)` — a assinatura permite escrita? (trial válido, ativo, past_due ou legado sem assinatura; só responde para membros). Usada nas policies de escrita
- `storage_workspace_writable(nome)` — a 1ª pasta do arquivo em `product-images` é um workspace do qual a pessoa é membro e que aceita escrita. Fotos de produto ficam em `<workspace_id>/...`
- Trigger `products_plan_limit` (BEFORE INSERT em products): limite de produtos do plano no banco (`plan_product_limit`: 50/300/2000, os mesmos de `plans.ts`), vale também para a RPC de nota. Mudou o limite em `plans.ts`? Mude a função também
- `stock_forecast(workspace_id)` — saídas dos últimos 30 dias por produto, para a previsão "dura ~X dias" do front (EQZ-16). SECURITY INVOKER (a RLS vale)
- `stock_last_outflow(workspace_id)` — data da última saída de cada produto, para o "R$ parados" (EQZ-18). SECURITY INVOKER
- `import_products(p_workspace_id, p_itens jsonb)` — importação de planilha numa transação (ver `POST /products/import`). SECURITY DEFINER: checa owner/admin e `workspace_is_writable`, trava o workspace; o limite do plano vale pela trigger
- `register_stock_count(product_id, counted)` — contagem do dia numa transação (produto travado). SECURITY DEFINER: checa membro, `workspace_is_writable` e plano Growth/Pro
- `email_exists(p_email text) → boolean` — verifica se email existe em auth.users. Ninguém usa mais: só o service_role executa (SCRUM-65, ela deixava descobrir quem tem conta)
- A RPC antiga `invite_member` e a edge function `invite-member` foram removidas (2026-10-17)

## Rate limiting (server.ts)
- Global: 200 req/min por usuário ou por IP. A chave vem de `src/lib/rateLimitKey.ts` (EQZ-44):
  - `user:<sub>` só se o JWT tiver assinatura ES256 válida (chaves públicas do JWKS do Supabase, verificadas localmente e guardadas por 10 min; `kid` desconhecido busca no máximo 1 vez por minuto) e não estiver vencido. Token forjado ou vencido conta pelo IP (antes, cada `sub` forjado ganhava um balde novo)
  - IP: no Railway (`RAILWAY_ENVIRONMENT_NAME` definido) vem do `X-Real-IP` que a borda grava; o `req.ip` lá é o do proxy interno. Pelo site o IP é o da Vercel (rewrite), por isso quem está logado conta pelo usuário. Sem `trustProxy`: o `X-Forwarded-For` pode ser forjado
- Criação de workspace/invite: 10 req/min (authStrict)
- Mutações em geral: 60 req/min (authWrite)

## Segurança
- `@fastify/helmet` — headers HTTP de segurança
- `@fastify/cors` — origens controladas por `ALLOWED_ORIGINS` no `.env`
- `@fastify/rate-limit` — proteção contra brute force e abuso
- `dbError()` — sanitiza erros do banco (impede vazamento de schema interno)
- `sanitize.ts` — funções de sanitização por tipo (text, code, number, email)

## Banco de dados
Mudanças de schema ficam em `supabase/migrations/` (uma por arquivo, com o motivo no comentário).
Para aplicar: MCP do Supabase (`apply_migration`) ou Supabase Dashboard → SQL Editor. O MCP recusa `DROP`/`DELETE`: esses o João cola no SQL Editor.
`database/schema.sql` está desatualizado.

## Variáveis de ambiente
Copiar `.env.example` → `.env` e preencher:

```
PORT=3001
NODE_ENV=development
SUPABASE_URL=https://SEU_PROJETO.supabase.co
SUPABASE_ANON_KEY=sua_anon_key_aqui
SUPABASE_SERVICE_ROLE_KEY=sua_service_role_key_aqui   # NUNCA expor no frontend
ALLOWED_ORIGINS=http://localhost:3000   # em produção o 1º é https://www.estoquizen.com.br (links de e-mail e volta do Stripe)
```
As variáveis `SMTP_*` não são mais usadas (o `mailer.ts` foi removido).

## Frontend (../estoquizen-frontend)
- Next.js App Router + TypeScript
- Usa proxy rewrite (`/api/v1/:path*` → `http://localhost:3001/api/v1/:path*`) para evitar mixed-content e CORS
- `.env.local` do frontend tem `NEXT_PUBLIC_API_URL=/api/v1` (relativo)
- Para acesso via rede local (celular/outro PC): `NEXT_PUBLIC_API_URL=/api/v1` continua funcionando pelo proxy
- HTTPS local: `next dev --experimental-https` com certificado mkcert (necessário para câmera em rede local)
- `reactStrictMode: false` no `next.config.ts` (evita double-mount que quebrava o BarcodeScanner)

### Páginas de auth do frontend
- `/login` — login email+senha + Google OAuth; erros em português
- `/forgot-password` — envia reset via `resetPasswordForEmail` com `redirectTo=/reset-password` e responde igual exista a conta ou não (não revela quem tem conta); cooldown 60s
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
- **Invite flow separado por tipo de usuário**: novo → `inviteUserByEmail`; não-confirmado → reenvia o convite sem apagar a conta; confirmado → magic link (`signInWithOtp`) para `/aceitar-convite`
- **PKCE flow**: Supabase usa `?code=` na URL (não hash `#type=recovery`). Sempre usar `exchangeCodeForSession(code)` explicitamente. O `onAuthStateChange` sozinho não é suficiente
- **Reset password sem passar pelo /auth/callback**: `redirectTo` do `resetPasswordForEmail` aponta direto para `/reset-password`, que troca o code ele mesmo. Evita conflito com `from_invite` no user_metadata de usuários que foram convidados antes
- **E-mail com domínio próprio**: Supabase Auth usa o SMTP do Resend (`smtp.resend.com`, remetente `noreply@estoquizen.com.br`, SPF/DKIM/DMARC ok). O Gmail gratuito de antes mandava os convites para o spam

---

## Sistema de Assinaturas — Implementado

### Plataforma
- **Stripe** (não AbacatePay)
- Usar **modo test** do Stripe durante desenvolvimento — cartões de teste não cobram nada
- Stripe CLI para receber webhooks localmente: `stripe listen --forward-to localhost:3001/webhooks/stripe`

### Modelo de cobrança
- **Por workspace** (não por usuário) — 1 workspace = 1 assinatura = 1 Stripe Customer
- Se o usuário tiver múltiplos workspaces, cada um tem sua própria assinatura independente

### Planos
| Slug no banco | Label | Preço | Produtos | Membros |
|---|---|---|---|---|
| `basic` | Basic | R$24,90/mês | 50 | 3 |
| `growth` | Growth | R$39,90/mês | 300 | 10 |
| `pro` | Pro | R$59,90/mês | 2000 | sem limite |

### Modelo de trial
- **Apenas o plano `growth` tem trial gratuito** — `basic` e `pro` exigem pagamento imediato
- Trial é **1 por pessoa e 1 por CPF** — a API tenta inserir em `trial_grants` (índices únicos em user_id e no hash do CPF); se der conflito, cria sem trial. CPF de outra conta também fica sem trial
- CPF é **obrigatório** para todos os planos e validado antes de criar o workspace; salvo em `profiles.cpf` (só na primeira vez — não sobrescreve)
- Workspace **sem** linha em `subscriptions` criado a partir de 2026-10-01 é bloqueado por `assertActiveSubscription`; os de antes do sistema de assinaturas (ex.: "Assai Atacadista") seguem liberados
- O Stripe **não é criado durante o trial** — a assinatura é puramente local no banco
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

### Rotas de billing (`src/routes/v1/billing.ts`)
```
GET  /billing/subscription      — estado da assinatura (qualquer membro)
POST /billing/checkout          — cria Stripe Checkout Session (só owner)
POST /billing/portal            — cria Customer Portal Session (só owner); { flow: "cancel" } abre direto o cancelamento
POST /webhooks/stripe           — recebe eventos do Stripe
```
Não existem `/billing/cancel` nem `/billing/upgrade`: cancelamento e cartão ficam no portal (em pt-BR).
Cancelar a assinatura (fim do ciclo, dados ficam) e excluir o workspace (`DELETE /workspaces/:id`, apaga tudo e cancela na hora) são ações separadas no front (SCRUM-63).
**Troca de plano (SCRUM-47 parte 2):** quem já assina (`active`/`past_due` com `stripe_subscription_id`) e pede outro plano
em `/billing/checkout` não ganha uma segunda assinatura: recebe um link do portal com `subscription_update_confirm`
(409 se já for o plano atual). O portal (modo de teste) tem "Clientes podem trocar de plano" ligado com os 3 preços atuais,
cobrança proporcional na hora (`always_invoice`) e downgrade imediato. O modo real tem configuração separada: repetir ao virar.
Antes de trocar (subir ou descer), `/billing/checkout` confere se o uso cabe no plano escolhido (`usoAcimaDoPlano`: produtos e
membros ativos + convites pendentes) e responde 409 com o motivo ("Você tem 120 produtos e o Basic vai até 50: remova 70...").
Sem isso, quem desce de plano continuaria usando o que passou do limite pagando menos (o banco só barra cadastro novo).

**CRÍTICO no webhook:**
- Rota `/webhooks/stripe` **NÃO tem** `preHandler: [fastify.authenticate]` — o Stripe não envia JWT
- Validar assinatura com `stripe.webhooks.constructEvent(rawBody, stripeSignatureHeader, STRIPE_WEBHOOK_SECRET)`
- O `rawBody` é capturado via `addContentTypeParser("application/json", { parseAs: "buffer" }, ...)` em `server.ts` — salvo em `(req as any).rawBody`
- `STRIPE_WEBHOOK_SECRET` deve ser adicionada como variável no nível do **serviço** no Railway (não projeto) — se aparecer só no "raw editor JSON" mas não na lista normal, não está sendo injetada no processo
- **Nunca ativar assinatura pela success URL do Checkout** — sempre pelo webhook

### Webhooks do Stripe a ouvir
| Evento | Ação no backend |
|---|---|
| `checkout.session.completed` | `status = active` — mais confiável para a primeira cobrança, metadata direto na session. Manda o e-mail "Assinatura confirmada" ao dono, uma vez por assinatura (`subscriptions.confirmation_email_sub_id`); falha no e-mail só vai para o log |
| `invoice.paid` | `status = active`, atualiza `current_period_end`, atualiza `workspaces.plan` |
| `invoice.payment_failed` | `status = past_due` (não bloqueia ainda — Stripe vai retentar) |
| `customer.subscription.updated` | Atualiza `plan`, `status`, `cancel_at_period_end`, `stripe_price_id` |
| `customer.subscription.deleted` | `status = canceled` — acesso limitado a leitura |

Detalhes da API `2026-03-25.dahlia` (SCRUM-46 e 47):
- `current_period_end` fica em `items.data[0]`, não na Subscription; a fatura aponta a assinatura em `parent.subscription_details`
- o plano vem do **preço** (`PRICE_IDS`); o metadata guarda só o plano da compra
- `unpaid`/`paused` → `canceled`; `incomplete` não altera o status (a tabela não aceita esses status)
- `cancel_at` (cancelamento agendado pelo portal) conta como `cancel_at_period_end`
- `updated`/`deleted`/`payment_failed` de uma assinatura que não é a gravada no workspace são ignorados
- erro ao gravar responde 500, para o Stripe reenviar o evento

### Grace period após falha de pagamento
- **Delegar ao Stripe Smart Retries** (configurar no Stripe Dashboard: 3 tentativas em ~7 dias)
- Backend só bloqueia quando `status = canceled` ou `status = unpaid` (Stripe desistiu)
- Nunca bloquear imediatamente em `past_due`

### Cancelamento
- Usuário cancela → `cancel_at_period_end = true` (não cancela imediato)
- Continua com acesso até o fim do ciclo pago
- No fim do ciclo, Stripe emite `customer.subscription.deleted` → webhook muda para `status = canceled`

### Job agendado (deleção de workspaces) — `src/lib/cleanup.ts`
- Roda **todo dia às 4h UTC** via `node-cron` e **toda vez que o servidor sobe em produção** (com o sleep do Railway, o cron das 4h pode não rodar; assim cada vez que a API acorda o job recupera o atraso). Uma trava evita duas rodadas ao mesmo tempo
- A contagem usa `subscriptions.expired_at`, preenchido pela trigger `subscriptions_track_expiry` quando a assinatura entra em `trial_expired`/`canceled` (no trial vencido, a data do fim do trial) e limpo quando sai. Antes usava `updated_at`, que muda com qualquer atualização (SCRUM-56)
- Fluxo em ordem:
  1. `trialing` + `trial_ends_at < now()` → atualiza para `trial_expired` (a API também faz isso na hora, em `assertActiveSubscription` e `GET /billing/subscription`)
  2. expirado há 30+ dias **e com o último aviso há 3+ dias** (`final_warned_at`) → deleta workspace (cascade) + email de confirmação. Ninguém é excluído sem os dois avisos
  3. expirado há 14+ dias e `warned_at` vazio → envia o aviso **uma vez** e grava `warned_at` (antes saía todo dia entre o 14º e o 29º dia). Se o Resend falhar, tenta de novo na próxima rodada
  4. expirado há 27+ dias, primeiro aviso há 3+ dias e `final_warned_at` vazio → envia o **último aviso** ("Último aviso: ... será excluído em 3 dias") e grava `final_warned_at` (desde 2026-10-20). Se o job ficou parado, os avisos e a exclusão atrasam juntos
- Emails via **Resend** (`src/lib/resend.ts`) — HTTP, sem SMTP bloqueado no Railway
- Endpoint manual `POST /admin/cleanup` (protegido por `CRON_SECRET`) para forçar execução

### Variáveis de ambiente adicionais
```
STRIPE_SECRET_KEY=sk_test_...          # chave secreta do Stripe (test mode)
STRIPE_WEBHOOK_SECRET=whsec_...        # segredo de assinatura do endpoint no Stripe Dashboard
STRIPE_PRICE_BASIC=price_...           # ID do Price no Stripe Dashboard
STRIPE_PRICE_GROWTH=price_...
STRIPE_PRICE_PRO=price_...
RESEND_API_KEY=re_...                  # Resend — emails de aviso/deleção
CRON_SECRET=...                        # segredo para chamar POST /admin/cleanup manualmente
```

> **ATENÇÃO Railway**: adicionar `STRIPE_WEBHOOK_SECRET` no nível do **serviço** (aba Variables do serviço), não do projeto. Se aparecer apenas no "raw editor JSON" mas não na lista normal de variáveis, o processo não está recebendo a var.

### Status de implementação — 2026-04-23

#### ✅ Concluído
1. Renomear `intermediate` → `growth` — planos `basic/growth/pro`, preços R$19,90/R$29,90/R$59,90
2. Tabela `subscriptions` criada no Supabase
3. `POST /workspaces` — cria subscription automaticamente; only `growth` tem trial; CPF obrigatório, salvo em `profiles.cpf`; limite de 1 trial por CPF
4. `src/lib/stripe.ts` + `src/routes/v1/billing.ts` (checkout, portal, subscription)
5. `POST /webhooks/stripe` — `src/routes/webhooks.ts`
   - Raw body via `addContentTypeParser("application/json", { parseAs: "buffer" })` em `server.ts`
   - Eventos: `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated/deleted`
   - `success_url` / `cancel_url` apontam para `/select-workspace` (não `/dashboard`) para evitar perda de sessão
6. Frontend: `plan-selection` → basic/pro redirecionam ao Stripe imediatamente; growth vai para `/select-workspace` com trial
7. Frontend: `register-company` coleta CPF, salva em sessionStorage; `plan-selection` lê de lá
8. Frontend: `select-workspace` mostra banner verde/vermelho com `?checkout=success/canceled`
9. Frontend: `TrialBanner` no dashboard (`src/components/dashboard/TrialBanner.tsx`)
10. Frontend: `/configuracoes` — seção billing funcional (upgrade, portal, encerrar)
11. `src/lib/checkSubscription.ts` — `assertActiveSubscription()` bloqueia com 403 em `trial_expired/canceled/deleted`; aplicado em POST/PATCH/DELETE products, adjust, invite, PATCH workspace
12. `src/lib/cleanup.ts` — node-cron às 4h UTC: trialing→trial_expired, aviso email dia 14, deleção dia 30 (via Resend)
13. `DELETE /workspaces/:id` cancela assinatura no Stripe antes de deletar
14. `profiles.cpf` column + unique index no Supabase
15. Webhook cadastrado no Stripe Dashboard com eventos: `checkout.session.completed`, `customer.subscription.deleted/updated`, `invoice.paid`, `invoice.payment_failed`

#### 🔜 Pendente
- Lista completa de tarefas: quadro do projeto no Obsidian (`Projetos/Estoquizen - Quadro.md`)
