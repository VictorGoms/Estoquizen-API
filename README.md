# Estoquizen API

API REST do **Estoquizen**, um SaaS de gestão de estoque para pequenos negócios. Cada empresa tem o seu espaço (workspace) com equipe, papéis de acesso e assinatura própria. Produtos entram manualmente, por leitor de código de barras ou importando a NFC-e (cupom fiscal) direto da SEFAZ.

🔗 **Aplicação:** https://estoquizen.vercel.app  
🖥️ **Frontend:** [VictorGoms/Estoquizen](https://github.com/VictorGoms/Estoquizen)

---

## Destaques técnicos

- **Multi-tenant com Row Level Security.** O isolamento entre empresas é garantido no Postgres por policies de RLS, não só no código. Rotas comuns usam um client Supabase autenticado com o JWT do usuário (`supabaseForUser(token)`), então o banco aplica as policies. O client com service role só é usado em operações privilegiadas e explícitas.
- **Autenticação JWT e papéis.** O token do Supabase Auth é validado em um plugin Fastify (`fastify.authenticate`). Cada membro tem um papel (`owner`, `admin` ou `member`). Os convites seguem fluxos diferentes para usuário novo, usuário ainda não confirmado e usuário que já tem conta.
- **Billing com Stripe.** Checkout Session, Customer Portal e webhook com validação de assinatura sobre o *raw body*. Eventos tratados: `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated` e `customer.subscription.deleted`. A assinatura só é ativada pelo webhook, nunca pela URL de retorno do checkout.
- **Trial e ciclo de vida da assinatura.** O plano Growth tem trial limitado a 1 por CPF. Um job com `node-cron` roda todo dia às 4h UTC: expira trials, envia e-mail de aviso (via Resend) após 14 dias sem pagamento e remove o workspace após 30. Workspaces expirados ficam em modo somente leitura (403 nas rotas de escrita).
- **Importação de NFC-e.** Recebe a chave de 44 dígitos, identifica o estado pelo código da UF e faz *scraping* do portal público da SEFAZ com `cheerio`. Os itens são normalizados (unidade, preço unitário, EAN) e o resultado fica em cache por 24h, já que a nota é imutável. O foco é SP; URLs de outros 9 estados estão mapeadas.
- **Ajuste de estoque atômico.** Entradas e saídas passam pela função Postgres `adjust_product_qty`, que atualiza a quantidade e grava o histórico em `movements` na mesma transação. Isso evita condição de corrida com vários usuários ao mesmo tempo e impede estoque negativo. As quantidades são decimais, para kg e litros.
- **Limites por plano no servidor.** Número de produtos, membros e convites por dia são validados na API a partir de uma única fonte de verdade (`src/lib/plans.ts`).
- **Validação e segurança.** Todo body é validado com **Zod** antes de chegar no banco, com sanitização por tipo (texto, código, e-mail, CPF). Erros do banco passam por `dbError()` para não expor nomes de tabelas ou constraints. A API usa `@fastify/helmet`, CORS restrito por variável de ambiente e rate limit por usuário (com fallback para IP).
- **Documentação.** Swagger UI em `/docs`.
- **Respostas padronizadas.** As rotas de `/api/v1` respondem no formato `{ data, error }`.

## Arquitetura

```mermaid
flowchart LR
    U[Usuário<br/>navegador / celular] --> F[Frontend<br/>Next.js · Vercel]
    F -- "REST + JWT<br/>/api/v1/*" --> A[Estoquizen API<br/>Fastify · Railway]
    F -- "Auth, leituras com RLS,<br/>upload de imagens" --> S[(Supabase<br/>Postgres + Auth + Storage)]
    A -- "queries com RLS<br/>(token do usuário)" --> S
    A -- "Checkout / Portal" --> ST[Stripe]
    ST -- "webhooks" --> A
    A -- "scraping NFC-e" --> SF[Portais SEFAZ]
    A -- "e-mails de aviso" --> R[Resend]
```

## Stack

| Camada | Tecnologia |
|---|---|
| Runtime | Node.js + TypeScript (ESM) |
| Framework | Fastify 5 |
| Banco / Auth | Supabase (Postgres, RLS, funções PL/pgSQL), sem ORM |
| Validação | Zod |
| Pagamentos | Stripe (Checkout, Billing Portal, Webhooks) |
| Jobs | node-cron |
| E-mail | Resend |
| Scraping | cheerio |
| Segurança | @fastify/helmet, @fastify/cors, @fastify/rate-limit |
| Docs | @fastify/swagger + Swagger UI |

## Rotas

Todas ficam sob `/api/v1` e exigem `Authorization: Bearer <access_token>`, exceto as indicadas.

| Método | Rota | Descrição |
|---|---|---|
| GET | `/health` | Health check (pública) |
| GET | `/products?workspace_id=` | Lista produtos do workspace |
| GET | `/products/:id` | Detalhe do produto |
| POST | `/products` | Cria produto (valida limite do plano) |
| PATCH | `/products/:id` | Atualiza produto |
| DELETE | `/products/:id` | Remove produto (owner/admin, via RLS) |
| POST | `/products/:id/adjust` | Entrada/saída de estoque (atômico) |
| GET | `/products/:id/movements` | Histórico de movimentações |
| GET | `/workspaces` | Workspaces do usuário |
| GET | `/workspaces/:id/stats` | Contadores do dashboard |
| POST | `/workspaces` | Cria workspace, owner e assinatura |
| PATCH | `/workspaces/:id` | Atualiza workspace |
| DELETE | `/workspaces/:id` | Exclui workspace (só owner; cancela no Stripe) |
| GET | `/members?workspace_id=` | Lista membros com perfil |
| POST | `/members/invite` | Convida membro (limite do plano e diário) |
| POST | `/members/accept` | Aceita convite pendente |
| PATCH | `/members/:id` | Atualiza papel/status/perfil |
| DELETE | `/members/:id/invite` | Revoga convite pendente |
| DELETE | `/members/:id` | Remove membro |
| POST | `/nfe/consultar` | Consulta NFC-e pela chave de 44 dígitos |
| GET | `/billing/subscription?workspace_id=` | Estado da assinatura |
| POST | `/billing/checkout` | Cria Stripe Checkout Session |
| POST | `/billing/portal` | Cria sessão do Customer Portal |
| POST | `/webhooks/stripe` | Webhook do Stripe (fora de `/api/v1`, sem JWT, valida assinatura) |
| POST | `/admin/cleanup` | Executa o job de limpeza manualmente (fora de `/api/v1`, protegido por `CRON_SECRET`) |

A especificação completa fica em `http://localhost:3001/docs` com a API rodando.

## Estrutura

```
src/
  server.ts            bootstrap: plugins, rate limit, swagger, cron
  plugins/auth.ts      validação do JWT → req.user
  routes/v1/           products, workspaces, members, nfe, billing
  routes/webhooks.ts   webhook do Stripe
  routes/admin/        disparo manual do cleanup
  schemas/             schemas Zod
  lib/                 supabase, planos, NFC-e, Stripe, cleanup, sanitização, respostas
database/
  schema.sql           tabelas, RLS e funções
  seed.sql             dados de exemplo
```

## Como rodar localmente

**Pré-requisitos:** Node.js 20+, um projeto no [Supabase](https://supabase.com) e, para billing, uma conta Stripe em modo teste.

```bash
git clone https://github.com/VictorGoms/Estoquizen-API.git
cd Estoquizen-API
npm install
cp .env.example .env    # preencha com as suas chaves
```

1. **Banco.** No Supabase, abra o SQL Editor e rode `database/schema.sql` (opcionalmente, `database/seed.sql` depois).
   > ⚠️ O `schema.sql` ainda não inclui a parte de billing: tabela `subscriptions`, coluna `profiles.cpf`, plano `growth` no check de `workspaces.plan`. Consolidar isso em migrações versionadas está em [Próximos passos](#próximos-passos).
2. **Variáveis.** O `.env.example` lista e explica cada variável: Supabase, CORS, Stripe, Resend, `CRON_SECRET`.
3. **Subir a API:**
   ```bash
   npm run dev      # http://localhost:3001  ·  docs em /docs
   ```
4. **Webhooks do Stripe (opcional):**
   ```bash
   stripe listen --forward-to localhost:3001/webhooks/stripe
   ```

Outros scripts: `npm run build` (compila para `dist/`), `npm start` (roda o build) e `npm run lint` (checagem de tipos).

## Próximos passos

O projeto foi construído como produto real. Estes pontos ainda não existem e são os próximos da lista:

- **Testes automatizados.** Unitários para regras de plano, sanitização e parsing da NFC-e; testes de integração das rotas, incluindo as policies de RLS.
- **Migrações versionadas.** Substituir o `schema.sql` único por migrações (Supabase CLI) para que o banco seja reproduzível do zero.
- **CI.** Pipeline no GitHub Actions com type-check, build e testes a cada push/PR.
- **Docker.** `Dockerfile` e `docker-compose` para subir o ambiente local com um comando.
- **Revisão de autorização.** Checagem explícita de participação no workspace em todas as rotas que usam o client com service role.
- **Observabilidade.** Logs estruturados e alertas para falhas do webhook e do job de limpeza.

## Autor

**João Victor** · [GitHub](https://github.com/VictorGoms) · [LinkedIn](https://www.linkedin.com/in/jo%C3%A3o-victor-da-silva-gomes-a47315237)
