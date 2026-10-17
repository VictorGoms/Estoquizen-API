import { supabaseAdmin } from "./supabase.js";
import { sendExpirationWarningEmail, sendWorkspaceDeletionEmail } from "./resend.js";

const EXPIRED_STATUSES  = ["trial_expired", "canceled"];
const WARN_AFTER_DAYS   = 14;
const DELETE_AFTER_DAYS = 30;

export async function runCleanup(): Promise<{
  expired: number; deleted: number; warned: number; deleteErrors: string[]; emailErrors: string[];
}> {
  const now          = new Date();
  const warnCutoff   = new Date(now.getTime() - WARN_AFTER_DAYS   * 24 * 60 * 60 * 1000).toISOString();
  const deleteCutoff = new Date(now.getTime() - DELETE_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString();

  /* ── 0. Transicionar trialing → trial_expired quando trial_ends_at passou ── */
  const { data: expiredRows } = await supabaseAdmin
    .from("subscriptions")
    .update({ status: "trial_expired", updated_at: now.toISOString() })
    .eq("status", "trialing")
    .lt("trial_ends_at", now.toISOString())
    .select("id");
  const expired = expiredRows?.length ?? 0;

  /* ── 1. Deletar workspaces expirados há 30+ dias ── */
  const { data: toDelete } = await supabaseAdmin
    .from("subscriptions")
    .select("workspace_id, workspaces(id, name, created_by)")
    .in("status", EXPIRED_STATUSES)
    .lte("updated_at", deleteCutoff);

  let deleted = 0;
  const deleteErrors: string[] = [];
  const emailErrors: string[]  = [];

  for (const row of toDelete ?? []) {
    const ws = row.workspaces as unknown as { id: string; name: string; created_by: string } | null;
    if (!ws) continue;

    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("email")
      .eq("id", ws.created_by)
      .maybeSingle();

    const { error: delErr } = await supabaseAdmin
      .from("workspaces")
      .delete()
      .eq("id", ws.id);

    if (delErr) {
      deleteErrors.push(`${ws.id}: ${delErr.message}`);
      continue;
    }

    deleted++;

    if (profile?.email) {
      try {
        await sendWorkspaceDeletionEmail({ to: profile.email, workspaceName: ws.name });
      } catch (err) {
        emailErrors.push(`exclusão ${ws.id}: ${(err as Error).message}`);
      }
    }
  }

  /* ── 2. Avisar workspaces expirados entre 14 e 29 dias ── */
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

    const daysExpired     = Math.floor((now.getTime() - new Date(row.updated_at as string).getTime()) / (24 * 60 * 60 * 1000));
    const daysUntilDelete = Math.max(1, DELETE_AFTER_DAYS - daysExpired);

    try {
      await sendExpirationWarningEmail({ to: profile.email, workspaceName: ws.name, daysUntilDelete });
      warned++;
    } catch (err) {
      emailErrors.push(`aviso ${ws.id}: ${(err as Error).message}`);
    }
  }

  return { expired: expired ?? 0, deleted, warned, deleteErrors, emailErrors };
}
