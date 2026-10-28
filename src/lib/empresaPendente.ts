import { supabaseAdmin } from "./supabase.js";
import { fimDoTeste } from "./trial.js";

/*
 * Workspace esperando pagamento (2026-10-28, pedido do João: ninguém criar 500 empresas). Quem já usou o teste
 * grátis (1 por pessoa e por CPF) cria o workspace e paga na hora; se fecha o pagamento, ele fica bloqueado.
 * Cada pessoa pode ter só um assim: nasceu sem teste (`trial_ends_at` vazio), está `trial_expired` e nunca
 * teve assinatura no Stripe. Para criar outro, assina ou exclui esse.
 */
export async function workspaceEsperandoPagamento(userId: string) {
  const { data: meus, error } = await supabaseAdmin.from("workspaces").select("id, name").eq("created_by", userId);
  if (error || !meus?.length) return { pendente: null, error };

  const { data: sub, error: subErr } = await supabaseAdmin
    .from("subscriptions")
    .select("workspace_id")
    .in("workspace_id", meus.map((w) => w.id))
    .eq("status", "trial_expired")
    .is("trial_ends_at", null)
    .is("stripe_subscription_id", null)
    .limit(1)
    .maybeSingle();
  if (subErr || !sub) return { pendente: null, error: subErr };

  const ws = meus.find((w) => w.id === sub.workspace_id);
  return { pendente: ws ? { id: ws.id as string, name: ws.name as string } : null, error: null };
}

export const msgWorkspacePendente = (nome: string) =>
  `Você já tem o workspace "${nome}" esperando pagamento. Assine por ele na escolha de workspace ou exclua-o em Configurações antes de criar outro.`;

/*
 * Teste da própria conta (decisão do João em 2026-10-28: o teste é da pessoa, não do workspace). Se o workspace
 * do teste foi excluído e o prazo ainda não acabou, o próximo workspace usa o mesmo teste, até a mesma data,
 * sem dia a mais: quem se atrapalhou e recomeçou não cai no pagamento, e ninguém estica o teste.
 * `trial_grants.workspace_id` não tem chave estrangeira: depois da exclusão aponta para um id que não existe.
 */
export async function testeDaConta(userId: string) {
  const { data: grant, error } = await supabaseAdmin
    .from("trial_grants")
    .select("id, workspace_id, granted_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !grant) return { grant: null, recomecarAte: null, error };

  const fim = fimDoTeste(new Date(grant.granted_at as string));
  if (fim <= new Date()) return { grant, recomecarAte: null, error: null };

  if (grant.workspace_id) {
    const { data: ws, error: wsErr } = await supabaseAdmin
      .from("workspaces").select("id").eq("id", grant.workspace_id).maybeSingle();
    if (wsErr) return { grant, recomecarAte: null, error: wsErr };
    if (ws) return { grant, recomecarAte: null, error: null };   // o workspace do teste continua existindo
  }
  return { grant, recomecarAte: fim, error: null };
}
