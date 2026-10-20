import { supabaseAdmin } from "./supabase.js";
import { sendExpirationWarningEmail, sendWorkspaceDeletionEmail } from "./resend.js";

const EXPIRED_STATUSES  = ["trial_expired", "canceled"];
const WARN_AFTER_DAYS   = 14;
const DELETE_AFTER_DAYS = 30;
/* Ninguém é excluído sem os dois avisos: o último sai MIN_NOTICE_DAYS antes da exclusão, e só
   depois que o primeiro foi enviado há esse prazo. Se o job ficou dias sem rodar (sleep do
   Railway), os avisos saem atrasados e a exclusão espera junto */
const MIN_NOTICE_DAYS   = 3;
const FINAL_WARN_DAYS   = DELETE_AFTER_DAYS - MIN_NOTICE_DAYS;
const DAY_MS            = 24 * 60 * 60 * 1000;

/*
 * A contagem usa subscriptions.expired_at, que a trigger subscriptions_track_expiry preenche
 * quando a assinatura expira (no trial vencido, a data do fim do trial). Antes usava updated_at,
 * que muda com qualquer atualização, e o aviso saía todo dia; agora warned_at marca o envio.
 */

export async function runCleanup(): Promise<{
  expired: number; deleted: number; warned: number; finalWarned: number; deleteErrors: string[]; emailErrors: string[];
}> {
  const now          = new Date();
  const warnCutoff   = new Date(now.getTime() - WARN_AFTER_DAYS   * DAY_MS).toISOString();
  const deleteCutoff = new Date(now.getTime() - DELETE_AFTER_DAYS * DAY_MS).toISOString();
  const noticeCutoff = new Date(now.getTime() - MIN_NOTICE_DAYS   * DAY_MS).toISOString();
  const finalCutoff  = new Date(now.getTime() - FINAL_WARN_DAYS   * DAY_MS).toISOString();

  /* ── 0. Transicionar trialing → trial_expired quando trial_ends_at passou ── */
  const { data: expiredRows } = await supabaseAdmin
    .from("subscriptions")
    .update({ status: "trial_expired", updated_at: now.toISOString() })
    .eq("status", "trialing")
    .lt("trial_ends_at", now.toISOString())
    .select("id");
  const expired = expiredRows?.length ?? 0;

  /* ── 1. Excluir workspaces expirados há 30+ dias e com o último aviso há MIN_NOTICE_DAYS+ dias ── */
  const { data: toDelete } = await supabaseAdmin
    .from("subscriptions")
    .select("workspace_id, workspaces(id, name, created_by)")
    .in("status", EXPIRED_STATUSES)
    .lte("expired_at", deleteCutoff)
    .lte("final_warned_at", noticeCutoff);

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

  /* ── 2. Avisar (uma vez) quem expirou há 14+ dias ── */
  const { data: toWarn } = await supabaseAdmin
    .from("subscriptions")
    .select("workspace_id, expired_at, workspaces(id, name, created_by)")
    .in("status", EXPIRED_STATUSES)
    .lte("expired_at", warnCutoff)
    .is("warned_at", null);

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

    const daysExpired     = Math.floor((now.getTime() - new Date(row.expired_at as string).getTime()) / DAY_MS);
    const daysUntilDelete = Math.max(MIN_NOTICE_DAYS, DELETE_AFTER_DAYS - daysExpired);

    try {
      await sendExpirationWarningEmail({ to: profile.email, workspaceName: ws.name, daysUntilDelete });
    } catch (err) {
      emailErrors.push(`aviso ${ws.id}: ${(err as Error).message}`);
      continue;
    }

    /* Só marca depois do envio: se o Resend falhar, tenta de novo na próxima rodada */
    const { error: markErr } = await supabaseAdmin
      .from("subscriptions")
      .update({ warned_at: now.toISOString() })
      .eq("workspace_id", ws.id);
    if (markErr) emailErrors.push(`aviso ${ws.id} enviado, mas warned_at não gravou: ${markErr.message}`);
    warned++;
  }

  /* ── 3. Último aviso (uma vez), 3 dias antes da exclusão e pelo menos 3 dias depois do primeiro ── */
  const { data: toFinal } = await supabaseAdmin
    .from("subscriptions")
    .select("workspace_id, workspaces(id, name, created_by)")
    .in("status", EXPIRED_STATUSES)
    .lte("expired_at", finalCutoff)
    .lte("warned_at", noticeCutoff)
    .is("final_warned_at", null);

  let finalWarned = 0;

  for (const row of toFinal ?? []) {
    const ws = row.workspaces as unknown as { id: string; name: string; created_by: string } | null;
    if (!ws) continue;

    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("email")
      .eq("id", ws.created_by)
      .maybeSingle();

    if (!profile?.email) continue;

    try {
      await sendExpirationWarningEmail({ to: profile.email, workspaceName: ws.name, daysUntilDelete: MIN_NOTICE_DAYS, ultimoAviso: true });
    } catch (err) {
      emailErrors.push(`último aviso ${ws.id}: ${(err as Error).message}`);
      continue;
    }

    const { error: markErr } = await supabaseAdmin
      .from("subscriptions")
      .update({ final_warned_at: now.toISOString() })
      .eq("workspace_id", ws.id);
    if (markErr) emailErrors.push(`último aviso ${ws.id} enviado, mas final_warned_at não gravou: ${markErr.message}`);
    finalWarned++;
  }

  return { expired: expired ?? 0, deleted, warned, finalWarned, deleteErrors, emailErrors };
}
