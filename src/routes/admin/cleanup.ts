import type { FastifyPluginAsync } from "fastify";
import { supabaseAdmin } from "../../lib/supabase.js";
import { sendExpirationWarningEmail, sendWorkspaceDeletionEmail } from "../../lib/resend.js";

const EXPIRED_STATUSES = ["trial_expired", "canceled"];

/* Dias após expiração para enviar aviso e deletar */
const WARN_AFTER_DAYS   = 14; // avisa no dia 14
const DELETE_AFTER_DAYS = 30; // deleta no dia 30

const cleanupRoutes: FastifyPluginAsync = async (fastify) => {
  /* POST /admin/cleanup — chamado pelo Railway Cron diariamente
     Header obrigatório: Authorization: Bearer <CRON_SECRET>
  */
  fastify.post("/admin/cleanup", async (req, reply) => {
    const secret = process.env.CRON_SECRET ?? "";
    const auth   = (req.headers.authorization ?? "").replace("Bearer ", "");

    if (!secret || auth !== secret) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const now           = new Date();
    const warnCutoff    = new Date(now.getTime() - WARN_AFTER_DAYS   * 24 * 60 * 60 * 1000).toISOString();
    const deleteCutoff  = new Date(now.getTime() - DELETE_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString();

    /* ── 1. Workspaces a deletar (expirados há 30+ dias) ── */
    const { data: toDelete } = await supabaseAdmin
      .from("subscriptions")
      .select("workspace_id, workspaces(id, name, created_by)")
      .in("status", EXPIRED_STATUSES)
      .lte("updated_at", deleteCutoff);

    let deleted = 0;
    const deleteErrors: string[] = [];

    for (const row of toDelete ?? []) {
      const ws = row.workspaces as unknown as { id: string; name: string; created_by: string } | null;
      if (!ws) continue;

      /* Busca email do owner para notificar */
      const { data: profile } = await supabaseAdmin
        .from("profiles")
        .select("email, name")
        .eq("id", ws.created_by)
        .maybeSingle();

      /* Deleta workspace (cascade apaga members, products, movements, subscriptions) */
      const { error: delErr } = await supabaseAdmin
        .from("workspaces")
        .delete()
        .eq("id", ws.id);

      if (delErr) {
        deleteErrors.push(`${ws.id}: ${delErr.message}`);
        continue;
      }

      deleted++;

      /* Envia email de confirmação de exclusão (falha silenciosa — workspace já foi deletado) */
      if (profile?.email) {
        sendWorkspaceDeletionEmail({
          to:            profile.email,
          workspaceName: ws.name,
        }).catch(() => {/* ignora falha de email */});
      }
    }

    /* ── 2. Workspaces a avisar (expirados entre 14 e 29 dias) ── */
    const { data: toWarn } = await supabaseAdmin
      .from("subscriptions")
      .select("workspace_id, updated_at, workspaces(id, name, created_by)")
      .in("status", EXPIRED_STATUSES)
      .lte("updated_at", warnCutoff)
      .gt("updated_at", deleteCutoff);

    let warned = 0;

    for (const row of toWarn ?? []) {
      const ws = row.workspaces as unknown as { id: string; name: string; created_by: string } | null;
      if (!ws) continue;

      const { data: profile } = await supabaseAdmin
        .from("profiles")
        .select("email")
        .eq("id", ws.created_by)
        .maybeSingle();

      if (!profile?.email) continue;

      const expiredAt      = new Date(row.updated_at as string);
      const daysExpired    = Math.floor((now.getTime() - expiredAt.getTime()) / (24 * 60 * 60 * 1000));
      const daysUntilDelete = DELETE_AFTER_DAYS - daysExpired;

      sendExpirationWarningEmail({
        to:              profile.email,
        workspaceName:   ws.name,
        daysUntilDelete: Math.max(1, daysUntilDelete),
      }).catch(() => {/* ignora falha de email */});

      warned++;
    }

    fastify.log.info({ deleted, warned, deleteErrors }, "cleanup job concluído");

    return reply.send({
      ok:           true,
      deleted,
      warned,
      deleteErrors: deleteErrors.length > 0 ? deleteErrors : undefined,
    });
  });
};

export default cleanupRoutes;
