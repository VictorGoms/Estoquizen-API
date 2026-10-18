import type { FastifyPluginAsync } from "fastify";
import { InviteMemberSchema, UpdateMemberSchema } from "../../schemas/member.schema.js";
import { supabaseAdmin, supabaseForUser } from "../../lib/supabase.js";
import { ok, fail, dbError, sendDbError } from "../../lib/response.js";
import { getLimits } from "../../lib/plans.js";
import { assertActiveSubscription } from "../../lib/checkSubscription.js";
import { requireMember } from "../../lib/membership.js";

const membersRoutes: FastifyPluginAsync = async (fastify) => {
  const auth       = { preHandler: [fastify.authenticate] };
  const authWrite  = { preHandler: [fastify.authenticate], config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };
  const authStrict = { preHandler: [fastify.authenticate], config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

  /* GET /members?workspace_id=xxx */
  fastify.get("/members", auth, async (req, reply) => {
    const { workspace_id } = req.query as { workspace_id?: string };
    if (!workspace_id) return reply.status(400).send(fail("workspace_id é obrigatório"));

    if (!await requireMember(workspace_id, req.user.id, reply)) return;

    const { data: memberRows, error: membersErr } = await supabaseAdmin
      .from("workspace_members")
      .select("id, user_id, role, status, invited_by, created_at")
      .eq("workspace_id", workspace_id)
      .order("created_at");

    if (membersErr) return sendDbError(req, reply, membersErr);

    const userIds = (memberRows ?? []).map((r) => r.user_id);
    const profileMap = new Map<string, Record<string, unknown>>();

    if (userIds.length > 0) {
      const { data: profileRows } = await supabaseAdmin
        .from("profiles")
        .select("id, name, email, phone, avatar_color, avatar_url")
        .in("id", userIds);
      (profileRows ?? []).forEach((p) => profileMap.set(p.id, p));
    }

    const data = (memberRows ?? []).map((row) => ({
      ...row,
      profiles: profileMap.get(row.user_id) ?? null,
    }));

    return reply.send(ok(data));
  });

  /* POST /members/invite */
  fastify.post("/members/invite", authStrict, async (req, reply) => {
    const parsed = InviteMemberSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(fail(parsed.error.errors[0].message));

    const { email: rawEmail, name, role, workspace_id } = parsed.data;
    const email = rawEmail.toLowerCase().trim();

    const requesterRole = await requireMember(
      workspace_id, req.user.id, reply, ["owner", "admin"], "Só owner ou admin podem convidar membros.",
    );
    if (!requesterRole) return;
    if (role === "owner" && requesterRole !== "owner") {
      return reply.status(403).send(fail("Só o owner pode convidar outro owner."));
    }

    if (!await assertActiveSubscription(workspace_id, reply)) return;

    const { data: ws } = await supabaseAdmin
      .from("workspaces")
      .select("plan")
      .eq("id", workspace_id)
      .single();

    const limits = getLimits(ws?.plan ?? "basic");

    /* Limite diário: conta os e-mails de convite enviados (invite_log), inclusive reenvios e
       convites já revogados. Contar linhas de workspace_members deixava convidar/revogar sem fim. */
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count: dailyCount } = await supabaseAdmin
      .from("invite_log")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspace_id)
      .gte("created_at", since);

    if ((dailyCount ?? 0) >= limits.dailyInvites) {
      return reply.status(429).send(fail(
        `Limite de ${limits.dailyInvites} convites por dia atingido. Tente novamente amanhã.`
      ));
    }

    /* Conta já existente? Comparação exata sem diferenciar maiúsculas: escapa % e _, que no ilike
       são curingas (um e-mail com "_" podia casar com o de outra pessoa) */
    const { data: existingProfile } = await supabaseAdmin
      .from("profiles")
      .select("id")
      .ilike("email", email.replace(/[\\%_]/g, "\\$&"))
      .maybeSingle();

    /* Duplicidade antes de mandar qualquer e-mail */
    let pending: { id: string; role: string } | null = null;
    if (existingProfile) {
      const { data: membership } = await supabaseAdmin
        .from("workspace_members")
        .select("id, status, role")
        .eq("workspace_id", workspace_id)
        .eq("user_id", existingProfile.id)
        .maybeSingle();

      if (membership?.status === "ativo") {
        return reply.status(409).send(fail("Este usuário já é membro ativo do workspace."));
      }
      if (membership) pending = { id: membership.id, role: membership.role };
    }

    /* Pendentes + ativos contam juntos contra o limite do plano (reenvio não ocupa vaga nova) */
    if (!pending) {
      const { count: memberCount } = await supabaseAdmin
        .from("workspace_members")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspace_id)
        .in("status", ["ativo", "pendente"]);

      if ((memberCount ?? 0) >= limits.members) {
        return reply.status(403).send(fail(
          `Limite do plano ${limits.label} atingido: máximo de ${limits.members} membros (incluindo convites pendentes). Faça upgrade para continuar.`
        ));
      }
    }

    const siteUrl = (process.env.ALLOWED_ORIGINS ?? "https://estoquizen.vercel.app").split(",")[0].trim();
    const redirectTo = `${siteUrl}/auth/callback`;
    const metadata   = { name, workspace_id, role, from_invite: true };
    const emailFailed = (err: unknown, msg: string) => {
      req.log.error({ err, workspace_id }, msg);
      return reply.status(500).send(fail("Não foi possível enviar o e-mail de convite. Tente novamente em alguns minutos."));
    };

    let userId: string;

    if (!existingProfile) {
      /* Usuário novo — cria conta e envia e-mail de convite */
      const { data: invite, error: inviteErr } = await supabaseAdmin.auth.admin.inviteUserByEmail(
        email, { redirectTo, data: metadata },
      );
      if (inviteErr) return emailFailed(inviteErr, "falha ao enviar convite");
      userId = invite.user.id;

      /* Garante que o profile tem o nome — o trigger pode criar sem nome */
      await supabaseAdmin
        .from("profiles")
        .upsert({ id: userId, name, email }, { onConflict: "id" });
    } else {
      userId = existingProfile.id;
      const { data: { user: authUser } } = await supabaseAdmin.auth.admin.getUserById(userId);

      if (!authUser?.email_confirmed_at) {
        /* Nunca confirmou: reenvia o convite sem apagar a conta (apagar levava junto os convites
           pendentes dela em outros workspaces). O metadata aponta para este convite, que é o que
           o /set-password aceita. */
        await supabaseAdmin.auth.admin.updateUserById(userId, {
          user_metadata: { ...(authUser?.user_metadata ?? {}), ...metadata },
        });
        const { error: inviteErr } = await supabaseAdmin.auth.admin.inviteUserByEmail(
          email, { redirectTo, data: metadata },
        );
        if (inviteErr) return emailFailed(inviteErr, "falha ao reenviar convite");
      } else {
        /* Já tem conta confirmada — magic link para /aceitar-convite */
        const { error: otpErr } = await supabaseAdmin.auth.signInWithOtp({
          email,
          options: {
            shouldCreateUser: false,
            emailRedirectTo:  `${siteUrl}/aceitar-convite?workspace_id=${workspace_id}`,
          },
        });
        /* Sem o e-mail, gravar o convite deixaria um pendente que a pessoa nunca recebe */
        if (otpErr) return emailFailed(otpErr, "falha ao enviar magic link de convite");
      }
    }

    await supabaseAdmin.from("invite_log").insert({ workspace_id, invited_by: req.user.id });

    if (pending) {
      /* Convite pendente já existia: o e-mail foi reenviado; atualiza o papel se mudou */
      if (pending.role !== role) {
        await supabaseAdmin.from("workspace_members").update({ role }).eq("id", pending.id);
      }
      return reply.send(ok({ message: `Convite reenviado para ${email}.` }));
    }

    const { error: memberErr } = await supabaseAdmin
      .from("workspace_members")
      .insert({
        workspace_id,
        user_id:    userId,
        role,
        status:     "pendente",
        invited_by: req.user.id,
      });

    if (memberErr) return sendDbError(req, reply, memberErr);

    return reply.status(201).send(ok({ message: `Convite enviado para ${email}.` }));
  });

  /* POST /members/accept — usuário aceita convite pendente */
  fastify.post("/members/accept", auth, async (req, reply) => {
    const { workspace_id } = req.body as { workspace_id?: string };
    if (!workspace_id) return reply.status(400).send(fail("workspace_id é obrigatório"));

    const { data: membership } = await supabaseAdmin
      .from("workspace_members")
      .select("id, status")
      .eq("workspace_id", workspace_id)
      .eq("user_id", req.user.id)
      .maybeSingle();

    if (!membership) return reply.status(404).send(fail("Convite não encontrado"));
    if (membership.status === "ativo") return reply.send(ok({ message: "Já é membro ativo" }));

    const { error } = await supabaseAdmin
      .from("workspace_members")
      .update({ status: "ativo" })
      .eq("id", membership.id);

    if (error) return sendDbError(req, reply, error);
    return reply.send(ok({ message: "Convite aceito" }));
  });

  /* PATCH /members/:id?workspace_id=xxx — :id é o user_id do membro */
  fastify.patch("/members/:id", authWrite, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { workspace_id } = req.query as { workspace_id?: string };
    if (!workspace_id) return reply.status(400).send(fail("workspace_id é obrigatório"));

    const parsed = UpdateMemberSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(fail(parsed.error.errors[0].message));

    if (!await requireMember(workspace_id, req.user.id, reply, ["owner", "admin"])) return;

    const token = req.headers.authorization!.slice(7);
    const db    = supabaseForUser(token);

    const { name, phone, ...memberFields } = parsed.data;

    /* Atualiza campos do perfil se enviados */
    if (name !== undefined || phone !== undefined) {
      await db.from("profiles")
        .update({ ...(name ? { name } : {}), ...(phone !== undefined ? { phone } : {}) })
        .eq("id", id);
    }

    /* Atualiza role/status só neste workspace (antes atualizava o membro em todos os workspaces
       onde o requisitante é admin). Regras de owner ficam na trigger protect_workspace_owner. */
    if (Object.keys(memberFields).length > 0) {
      const { error } = await db
        .from("workspace_members")
        .update(memberFields)
        .eq("user_id", id)
        .eq("workspace_id", workspace_id);
      /* 42501 da trigger protect_workspace_owner vira 403 com a mensagem dela */
      if (error) return sendDbError(req, reply, error);
    }
    return reply.send(ok({ message: "Membro atualizado" }));
  });

  /* DELETE /members/:id/invite — revoga convite pendente */
  fastify.delete("/members/:id/invite", authStrict, async (req, reply) => {
    const { id }           = req.params as { id: string }; // user_id do convidado
    const { workspace_id } = req.query  as { workspace_id?: string };
    if (!workspace_id) return reply.status(400).send(fail("workspace_id é obrigatório"));

    /* Verifica que o requisitante é owner ou admin */
    const { data: requester } = await supabaseAdmin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspace_id)
      .eq("user_id", req.user.id)
      .eq("status", "ativo")
      .single();

    if (!requester || !["owner", "admin"].includes(requester.role)) {
      return reply.status(403).send(fail("Sem permissão para revogar convites"));
    }

    /* Confirma que existe convite pendente */
    const { data: membership } = await supabaseAdmin
      .from("workspace_members")
      .select("id")
      .eq("workspace_id", workspace_id)
      .eq("user_id", id)
      .eq("status", "pendente")
      .single();

    if (!membership) return reply.status(404).send(fail("Convite pendente não encontrado"));

    /* Verifica se o usuário nunca fez login (nunca ativou a conta) */
    const { data: { user: invitedUser } } = await supabaseAdmin.auth.admin.getUserById(id);
    const neverLoggedIn = !invitedUser?.last_sign_in_at;

    if (neverLoggedIn) {
      /* Deleta a conta — cascata remove workspace_members automaticamente */
      const { error: delErr } = await supabaseAdmin.auth.admin.deleteUser(id);
      if (delErr) return sendDbError(req, reply, delErr);
    } else {
      /* Usuário já tem conta ativa — remove só do workspace */
      const { error: delErr } = await supabaseAdmin
        .from("workspace_members")
        .delete()
        .eq("id", membership.id);
      if (delErr) return sendDbError(req, reply, delErr);
    }

    return reply.send(ok({ revoked: true, accountDeleted: neverLoggedIn }));
  });

  /* DELETE /members/:id — remove do workspace */
  fastify.delete("/members/:id", authWrite, async (req, reply) => {
    const { id }          = req.params as { id: string };
    const { workspace_id } = req.query as { workspace_id?: string };
    if (!workspace_id) return reply.status(400).send(fail("workspace_id é obrigatório"));

    const token = req.headers.authorization!.slice(7);
    const db    = supabaseForUser(token);

    const { error } = await db
      .from("workspace_members")
      .delete()
      .eq("user_id", id)
      .eq("workspace_id", workspace_id);

    /* 42501 da trigger protect_workspace_owner vira 403 com a mensagem dela */
    if (error) return sendDbError(req, reply, error);
    return reply.status(204).send();
  });
};

export default membersRoutes;
