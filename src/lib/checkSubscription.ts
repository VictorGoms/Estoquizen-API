import { supabaseAdmin } from "./supabase.js";
import { fail } from "./response.js";
import type { FastifyReply } from "fastify";

const BLOCKED = ["trial_expired", "canceled", "deleted"];

/* Workspaces de antes do sistema de assinaturas (abril/2026) não têm linha em subscriptions e
   continuam liberados. Os criados depois sempre ganham uma ao nascer: sem ela, bloqueia. */
const LEGACY_BEFORE = new Date("2026-10-01T00:00:00Z");

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
    .select("status")
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
