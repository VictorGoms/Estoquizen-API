import { supabaseAdmin } from "./supabase.js";
import { fail } from "./response.js";
import type { FastifyReply } from "fastify";

const BLOCKED = ["trial_expired", "canceled", "deleted"];

/* Workspaces de antes do sistema de assinaturas (abril/2026) não têm linha em subscriptions e
   continuam liberados. Os criados depois sempre ganham uma ao nascer: sem ela, bloqueia. */
const LEGACY_BEFORE = new Date("2026-10-01T00:00:00Z");

/**
 * Trial vencido vira trial_expired na hora, sem esperar o job diário (que não roda com a API
 * dormindo no Railway). Antes o acesso continuava total até o job rodar. Não faz nada se o
 * trial ainda vale ou se o status já é outro.
 */
export async function expireTrialIfDue(workspaceId: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin
    .from("subscriptions")
    .update({ status: "trial_expired", updated_at: now })
    .eq("workspace_id", workspaceId)
    .eq("status", "trialing")
    .lt("trial_ends_at", now);
  if (error) throw new Error(`falha ao expirar o trial: ${error.message}`);
}

/**
 * Verifica se o workspace tem assinatura ativa.
 * Retorna false e envia 403 se estiver bloqueado.
 * Retorna true se pode prosseguir.
 */
export async function assertActiveSubscription(
  workspaceId: string,
  reply: FastifyReply,
): Promise<boolean> {
  const { data: sub } = await supabaseAdmin
    .from("subscriptions")
    .select("status, trial_ends_at")
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (!sub) {
    const { data: ws } = await supabaseAdmin
      .from("workspaces")
      .select("created_at")
      .eq("id", workspaceId)
      .maybeSingle();
    if (ws && new Date(ws.created_at) < LEGACY_BEFORE) return true;

    reply.status(403).send(fail("Este workspace não tem assinatura. Escolha um plano para continuar."));
    return false;
  }

  if (sub.status === "trialing" && sub.trial_ends_at && new Date(sub.trial_ends_at) < new Date()) {
    /* Bloqueia de qualquer jeito; se a gravação falhar, o job diário acerta depois */
    await expireTrialIfDue(workspaceId).catch((err) => reply.log.error({ err, workspaceId }, "falha ao expirar o trial"));
    reply.status(403).send(fail("Seu período de teste acabou. Assine um plano para voltar a criar e editar."));
    return false;
  }

  if (BLOCKED.includes(sub.status)) {
    reply.status(403).send(fail(
      "Seu acesso expirou. Acesse o painel de cobrança para reativar sua assinatura."
    ));
    return false;
  }

  return true;
}

/** Busca o workspace_id de um produto (para rotas que só têm o product id). */
export async function getProductWorkspaceId(productId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("products")
    .select("workspace_id")
    .eq("id", productId)
    .maybeSingle();
  return data?.workspace_id ?? null;
}
