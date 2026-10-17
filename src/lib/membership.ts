import type { FastifyReply } from "fastify";
import { supabaseAdmin } from "./supabase.js";
import { fail } from "./response.js";

export type Role = "owner" | "admin" | "member";

/**
 * Confere se o usuário é membro ativo do workspace e, se `roles` vier, se tem um desses papéis.
 * Rotas que usam supabaseAdmin (ignora RLS) precisam chamar isto antes de ler ou gravar.
 *
 * Responde 404 quando não é membro (não revela se o workspace existe) e 403 quando o papel
 * não basta. Retorna o papel, ou null depois de já ter respondido.
 */
export async function requireMember(
  workspaceId: string,
  userId: string,
  reply: FastifyReply,
  roles?: Role[],
  forbiddenMessage = "Você não tem permissão para esta ação.",
): Promise<Role | null> {
  const { data } = await supabaseAdmin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .eq("status", "ativo")
    .maybeSingle();

  if (!data) {
    reply.status(404).send(fail("Workspace não encontrado."));
    return null;
  }

  const role = data.role as Role;
  if (roles && !roles.includes(role)) {
    reply.status(403).send(fail(forbiddenMessage));
    return null;
  }

  return role;
}
