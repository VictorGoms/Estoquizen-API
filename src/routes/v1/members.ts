import type { FastifyPluginAsync } from "fastify";
import { InviteMemberSchema, UpdateMemberSchema } from "../../schemas/member.schema.js";
import { supabaseAdmin, supabaseForUser } from "../../lib/supabase.js";
import { ok, fail, dbError } from "../../lib/response.js";
import { getLimits } from "../../lib/plans.js";
import { sendWorkspaceInviteEmail } from "../../lib/mailer.js";

const membersRoutes: FastifyPluginAsync = async (fastify) => {
  const auth       = { preHandler: [fastify.authenticate] };
  const authWrite  = { preHandler: [fastify.authenticate], config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };
  const authStrict = { preHandler: [fastify.authenticate], config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

  /* GET /members?workspace_id=xxx */
  fastify.get("/members", auth, async (req, reply) => {
    const { workspace_id } = req.query as { workspace_id?: string };
    if (!workspace_id) return reply.status(400).send(fail("workspace_id é obrigatório"));

    const { data: memberRows, error: membersErr } = await supabaseAdmin
      .from("workspace_members")
      .select("id, user_id, role, status, invited_by, created_at")
      .eq("workspace_id", workspace_id)
      .order("created_at");

    if (membersErr) return reply.status(500).send(fail(dbError(membersErr)));

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

    /* ── Validação de limite do plano ── */
    const { data: ws } = await supabaseAdmin
      .from("workspaces")
      .select("plan")
      .eq("id", workspace_id)
      .single();

    const limits = getLimits(ws?.plan ?? "basic");

    /* Pendentes + ativos contam juntos contra o limite do plano */
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

    /* Limite diário de convites por workspace */
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count: dailyCount } = await supabaseAdmin
      .from("workspace_members")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspace_id)
      .gte("created_at", since);

    if ((dailyCount ?? 0) >= limits.dailyInvites) {
      return reply.status(429).send(fail(
        `Limite de ${limits.dailyInvites} convites por dia atingido. Tente novamente amanhã.`
      ));
    }

    /* Verifica se o usuário já tem conta pelo email (case-insensitive) */
    const { data: existingProfile } = await supabaseAdmin
      .from("profiles")
      .select("id")
      .ilike("email", email)
      .maybeSingle();

    const siteUrl = (process.env.ALLOWED_ORIGINS ?? "https://estoquizen.vercel.app").split(",")[0].trim();
    const redirectTo = `${siteUrl}/auth/callback`;

    let userId: string;
    let confirmedUser = false;

    if (existingProfile) {
      /* Usuário existe — verificar se já confirmou o email (set-password) */
      const { data: { user: authUser } } = await supabaseAdmin.auth.admin.getUserById(existingProfile.id);
      confirmedUser = !!authUser?.email_confirmed_at;

      if (!confirmedUser) {
        /* Nunca clicou no link — deletar e re-convidar para enviar email novo */
        await supabaseAdmin.auth.admin.deleteUser(existingProfile.id);
        const { data: invite, error: inviteErr } = await supabaseAdmin.auth.admin.inviteUserByEmail(
          email,
          { redirectTo, data: { name, workspace_id, role, from_invite: true } },
        );
        if (inviteErr) return reply.status(500).send(fail(dbError(inviteErr)));
        userId = invite.user.id;
        await supabaseAdmin
          .from("profiles")
          .upsert({ id: userId, name, email }, { onConflict: "id" });
      } else {
        /* Usuário confirmado — gera magic link e envia email de convite */
        userId = existingProfile.id;

        const { data: { user: inviter } } = await supabaseAdmin.auth.admin.getUserById(req.user.id);
        const { data: inviterProfile }    = await supabaseAdmin.from("profiles").select("name").eq("id", req.user.id).single();
        const { data: wsData }            = await supabaseAdmin.from("workspaces").select("name").eq("id", workspace_id).single();

        const inviterName    = inviterProfile?.name ?? inviter?.email ?? "Alguém";
        const workspaceName  = wsData?.name ?? "um workspace";
        const acceptRedirect = `${siteUrl}/aceitar-convite?workspace_id=${workspace_id}`;

        const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
          type:    "magiclink",
          email,
          options: { redirectTo: acceptRedirect },
        });

        if (!linkErr && linkData?.properties?.action_link) {
          await sendWorkspaceInviteEmail({
            to:            email,
            toName:        name,
            workspaceName,
            inviterName,
            acceptLink:    linkData.properties.action_link,
          }).catch(() => { /* silencia erro de email — não bloqueia o convite */ });
        }
      }
    } else {
      /* Usuário novo — cria conta e envia email de convite */
      const { data: invite, error: inviteErr } = await supabaseAdmin.auth.admin.inviteUserByEmail(
        email,
        { redirectTo, data: { name, workspace_id, role, from_invite: true } },
      );
      if (inviteErr) return reply.status(500).send(fail(dbError(inviteErr)));
      userId = invite.user.id;

      /* Garante que o profile tem o nome — o trigger pode criar sem nome */
      await supabaseAdmin
        .from("profiles")
        .upsert({ id: userId, name, email }, { onConflict: "id" });
    }

    /* Garante que não há convite duplicado para o mesmo workspace */
    const { data: already } = await supabaseAdmin
      .from("workspace_members")
      .select("id, status")
      .eq("workspace_id", workspace_id)
      .eq("user_id", userId)
      .maybeSingle();

    if (already) {
      const msg = already.status === "ativo"
        ? "Este usuário já é membro ativo do workspace."
        : "Este usuário já possui um convite pendente.";
      return reply.status(409).send(fail(msg));
    }

    const memberStatus = "pendente";

    const { error: memberErr } = await supabaseAdmin
      .from("workspace_members")
      .insert({
        workspace_id,
        user_id:    userId,
        role,
        status:     memberStatus,
        invited_by: req.user.id,
      });

    if (memberErr) return reply.status(500).send(fail(dbError(memberErr)));

    const msg = `Convite enviado para ${email}.`;
    return reply.status(201).send(ok({ message: msg }));
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

    if (error) return reply.status(500).send(fail(dbError(error)));
    return reply.send(ok({ message: "Convite aceito" }));
  });

  /* PATCH /members/:id */
  fastify.patch("/members/:id", authWrite, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = UpdateMemberSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(fail(parsed.error.errors[0].message));

    const token = req.headers.authorization!.slice(7);
    const db    = supabaseForUser(token);

    const { name, phone, ...memberFields } = parsed.data;

    /* Atualiza campos do perfil se enviados */
    if (name !== undefined || phone !== undefined) {
      await db.from("profiles")
        .update({ ...(name ? { name } : {}), ...(phone !== undefined ? { phone } : {}) })
        .eq("id", id);
    }

    /* Atualiza role/status na tabela de membros */
    if (Object.keys(memberFields).length > 0) {
      await db.from("workspace_members").update(memberFields).eq("user_id", id);
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
      if (delErr) return reply.status(500).send(fail(dbError(delErr)));
    } else {
      /* Usuário já tem conta ativa — remove só do workspace */
      const { error: delErr } = await supabaseAdmin
        .from("workspace_members")
        .delete()
        .eq("id", membership.id);
      if (delErr) return reply.status(500).send(fail(dbError(delErr)));
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

    if (error) return reply.status(500).send(fail(dbError(error)));
    return reply.status(204).send();
  });
};

export default membersRoutes;
