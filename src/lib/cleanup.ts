import { supabaseAdmin } from "./supabase.js";
import {
  sendExpirationWarningEmail, sendWorkspaceDeletionEmail,
  sendTrialRecapEmail, sendTrialLastDayEmail, sendTrialEndedEmail, sendPauseEndingEmail, type ResumoWorkspace,
} from "./resend.js";
import { getLimits } from "./plans.js";
import { apagarFotosDoWorkspace, apagarFotosOrfas } from "./fotos.js";

const EXPIRED_STATUSES  = ["trial_expired", "canceled"];
const WARN_AFTER_DAYS   = 14;
const DELETE_AFTER_DAYS = 30;
/* Ninguém é excluído sem os dois avisos: o último sai MIN_NOTICE_DAYS antes da exclusão, e só
   depois que o primeiro foi enviado há esse prazo. Se o job ficou dias sem rodar (sleep do
   Railway), os avisos saem atrasados e a exclusão espera junto */
const MIN_NOTICE_DAYS   = 3;
const FINAL_WARN_DAYS   = DELETE_AFTER_DAYS - MIN_NOTICE_DAYS;
const DAY_MS            = 24 * 60 * 60 * 1000;

/* E-mails da reta final do trial (EQZ-05), contados pelo fim do teste (vale para 14 e 30 dias).
   As janelas cobrem mais de um dia porque a API dorme no Railway e o job pode atrasar; a do
   resumo termina onde começa a do último dia, para os dois não saírem juntos */
const RECAP_FROM_DAYS    = 4;    // resumo "o que você já fez": de 4 a 1,5 dia antes do fim
const LAST_DAY_FROM_DAYS = 1.5;  // "acaba amanhã": nas últimas 36 h
const ENDED_MIN_DAYS     = 1;    // "seus dados estão guardados": de 1 a 3 dias depois do fim
const ENDED_MAX_DAYS     = 3;    // (passou disso, não manda: ficaria fora de hora)

/*
 * A contagem usa subscriptions.expired_at, que a trigger subscriptions_track_expiry preenche
 * quando a assinatura expira (no trial vencido, a data do fim do trial). Antes usava updated_at,
 * que muda com qualquer atualização, e o aviso saía todo dia; agora warned_at marca o envio.
 */

type WorkspaceDaLinha = { id: string; name: string; created_by: string } | null;

async function emailDoCriador(userId: string): Promise<string | null> {
  const { data } = await supabaseAdmin.from("profiles").select("email").eq("id", userId).maybeSingle();
  return data?.email ?? null;
}

/** Números do workspace para os e-mails do trial (mesma regra de alerta do /stats e do front). */
async function resumoDoWorkspace(workspaceId: string): Promise<ResumoWorkspace> {
  const [{ data: produtos }, { count: movimentacoes }, { count: equipe }] = await Promise.all([
    supabaseAdmin.from("products").select("qty, min_qty").eq("workspace_id", workspaceId).limit(5000),
    supabaseAdmin.from("movements").select("id, products!inner(workspace_id)", { count: "exact", head: true })
      .eq("products.workspace_id", workspaceId),
    supabaseAdmin.from("workspace_members").select("user_id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId).eq("status", "ativo"),
  ]);
  const lista = produtos ?? [];
  return {
    produtos:      lista.length,
    movimentacoes: movimentacoes ?? 0,
    alertas:       lista.filter((p) => Number(p.qty) <= 0 || Number(p.qty) <= Number(p.min_qty)).length,
    equipe:        equipe ?? 1,
  };
}

export async function runCleanup(): Promise<{
  expired: number; deleted: number; warned: number; finalWarned: number; trialEmails: number; pauseReminders: number;
  fotosOrfas: number; deleteErrors: string[]; emailErrors: string[];
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

    /* As fotos ficam no Storage, fora do cascade do banco. Se falhar, a varredura de órfãs do fim
       desta rodada (ou da próxima) apaga */
    await apagarFotosDoWorkspace(ws.id).catch((err) => deleteErrors.push(`fotos ${ws.id}: ${(err as Error).message}`));

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

  /* ── 4. Reta final do trial (EQZ-05): resumo, último dia e "seus dados estão guardados" ── */
  const emDias = (dias: number) => new Date(now.getTime() + dias * DAY_MS).toISOString();
  let trialEmails = 0;

  type Etapa = "resumo" | "último dia" | "fim";
  const marcar = async (etapa: Etapa, workspaceId: string) => {
    const coluna = etapa === "resumo" ? "trial_recap_sent_at" : etapa === "último dia" ? "trial_last_day_sent_at" : "trial_ended_sent_at";
    const { error } = await supabaseAdmin.from("subscriptions").update({ [coluna]: now.toISOString() }).eq("workspace_id", workspaceId);
    if (error) emailErrors.push(`trial (${etapa}) ${workspaceId} enviado, mas ${coluna} não gravou: ${error.message}`);
  };

  const [{ data: paraResumo }, { data: paraUltimoDia }, { data: paraFim }] = await Promise.all([
    supabaseAdmin.from("subscriptions")
      .select("workspace_id, plan, trial_ends_at, workspaces(id, name, created_by)")
      .eq("status", "trialing")
      .gt("trial_ends_at", emDias(LAST_DAY_FROM_DAYS))
      .lte("trial_ends_at", emDias(RECAP_FROM_DAYS))
      .is("trial_recap_sent_at", null),
    supabaseAdmin.from("subscriptions")
      .select("workspace_id, plan, trial_ends_at, workspaces(id, name, created_by)")
      .eq("status", "trialing")
      .gt("trial_ends_at", now.toISOString())
      .lte("trial_ends_at", emDias(LAST_DAY_FROM_DAYS))
      .is("trial_last_day_sent_at", null),
    supabaseAdmin.from("subscriptions")
      .select("workspace_id, plan, expired_at, workspaces(id, name, created_by)")
      .eq("status", "trial_expired")
      .gte("expired_at", emDias(-ENDED_MAX_DAYS))
      .lte("expired_at", emDias(-ENDED_MIN_DAYS))
      .is("trial_ended_sent_at", null),
  ]);

  type LinhaTrial = { workspace_id: string; plan: string | null; trial_ends_at?: string; expired_at?: string; workspaces: unknown };
  const etapas: [Etapa, LinhaTrial[] | null][] = [["resumo", paraResumo], ["último dia", paraUltimoDia], ["fim", paraFim]];
  for (const [etapa, linhas] of etapas) {
    for (const row of linhas ?? []) {
      const ws = row.workspaces as unknown as WorkspaceDaLinha;
      if (!ws) continue;
      const to = await emailDoCriador(ws.created_by);
      if (!to) continue;

      const resumo = await resumoDoWorkspace(ws.id);
      const plano  = getLimits(row.plan ?? "growth");
      try {
        if (etapa === "fim") {
          const fimDoTeste = new Date(row.expired_at as string);
          await sendTrialEndedEmail({
            to, workspaceName: ws.name, fimDoTeste, resumo,
            guardadoAte: new Date(fimDoTeste.getTime() + DELETE_AFTER_DAYS * DAY_MS),
          });
        } else {
          const params = {
            to, workspaceName: ws.name, resumo, planLabel: plano.label, preco: plano.price,
            fimDoTeste: new Date(row.trial_ends_at as string),
          };
          await (etapa === "resumo" ? sendTrialRecapEmail(params) : sendTrialLastDayEmail(params));
        }
      } catch (err) {
        emailErrors.push(`trial (${etapa}) ${ws.id}: ${(err as Error).message}`);
        continue;
      }
      /* Só marca depois do envio: se o Resend falhar, tenta de novo na próxima rodada */
      await marcar(etapa, ws.id);
      trialEmails++;
    }
  }

  /* ── 5. Pausa acabando (EQZ-07): de 1 a 3 dias antes da volta, avisa que a cobrança recomeça ── */
  const { data: pausasAcabando } = await supabaseAdmin
    .from("subscriptions")
    .select("workspace_id, plan, pause_ends_at, workspaces(id, name, created_by)")
    .in("status", ["active", "past_due"])
    .gte("pause_ends_at", emDias(1))
    .lte("pause_ends_at", emDias(3))
    .is("pause_reminder_sent_at", null);

  let pauseReminders = 0;
  for (const row of pausasAcabando ?? []) {
    const ws = row.workspaces as unknown as WorkspaceDaLinha;
    if (!ws) continue;
    const to = await emailDoCriador(ws.created_by);
    if (!to) continue;
    try {
      await sendPauseEndingEmail({
        to, workspaceName: ws.name, fim: new Date(row.pause_ends_at as string), mensal: getLimits((row.plan as string) ?? "basic").price,
      });
    } catch (err) {
      emailErrors.push(`fim da pausa ${ws.id}: ${(err as Error).message}`);
      continue;
    }
    const { error } = await supabaseAdmin.from("subscriptions").update({ pause_reminder_sent_at: now.toISOString() }).eq("workspace_id", ws.id);
    if (error) emailErrors.push(`fim da pausa ${ws.id} enviado, mas pause_reminder_sent_at não gravou: ${error.message}`);
    pauseReminders++;
  }

  /* ── 6. Fotos de workspaces que não existem mais (exclusões antigas ou falha no passo 1) ── */
  let fotosOrfas = 0;
  try {
    fotosOrfas = (await apagarFotosOrfas()).fotos;
  } catch (err) {
    deleteErrors.push(`fotos órfãs: ${(err as Error).message}`);
  }

  return { expired: expired ?? 0, deleted, warned, finalWarned, trialEmails, pauseReminders, fotosOrfas, deleteErrors, emailErrors };
}
