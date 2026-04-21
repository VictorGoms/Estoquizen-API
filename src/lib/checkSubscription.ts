import { supabaseAdmin } from "./supabase.js";
import { fail } from "./response.js";
import type { FastifyReply } from "fastify";

const BLOCKED = ["trial_expired", "canceled", "deleted"];

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

  if (!sub) return true; // workspace sem subscription (legado) — deixa passar

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
