import { describe, it, expect, beforeEach, vi } from "vitest";
import { falso, montarApp, comoUsuario, type Consulta } from "./apoio/supabaseFalso.js";

vi.mock("../src/lib/supabase.js", async () => (await import("./apoio/supabaseFalso.js")).moduloSupabase());

const { default: membersRoutes } = await import("../src/routes/v1/members.js");

const WS    = "11111111-1111-4111-8111-111111111111";
const DONO  = "dono";
const COLEGA = "colega";
const CONVIDADO = "convidado";

/* Quem é membro ativo de quê (o que o requireMember consulta) */
function papelDe(c: Consulta): { role: string } | null {
  if (c.filtros.user_id === DONO && c.filtros.workspace_id === WS && c.filtros.status === "ativo") return { role: "owner" };
  return null;
}

describe("GET /members — convite pendente não revela o perfil (EQZ-54)", () => {
  beforeEach(() => {
    falso.limpar();
    falso.responder = (c) => {
      if (c.tabela === "workspace_members" && c.filtros.user_id) return { data: papelDe(c) };
      if (c.tabela === "workspace_members") {
        return { data: [
          { id: "m1", user_id: DONO,      role: "owner",  status: "ativo",    invited_by: null, created_at: "2026-10-01" },
          { id: "m2", user_id: COLEGA,    role: "member", status: "ativo",    invited_by: DONO, created_at: "2026-10-02" },
          { id: "m3", user_id: CONVIDADO, role: "member", status: "pendente", invited_by: DONO, created_at: "2026-10-03" },
        ] };
      }
      if (c.tabela === "profiles") {
        return { data: [
          { id: DONO,      name: "Dono",      email: "dono@x.com",   phone: "11 1111", avatar_color: "#111", avatar_url: null },
          { id: COLEGA,    name: "Colega",    email: "colega@x.com", phone: "11 2222", avatar_color: "#222", avatar_url: "https://a" },
          { id: CONVIDADO, name: "Vítima",    email: "vitima@x.com", phone: "11 9999", avatar_color: "#999", avatar_url: "https://v" },
        ] };
      }
      return undefined;
    };
  });

  it("colega ativo aparece com o perfil; convidado pendente, só com o e-mail do convite", async () => {
    const app = await montarApp(membersRoutes);
    const res = await app.inject({ method: "GET", url: `/api/v1/members?workspace_id=${WS}`, headers: comoUsuario(DONO) });

    expect(res.statusCode).toBe(200);
    const linhas = res.json().data as { user_id: string; profiles: Record<string, unknown> }[];
    const colega   = linhas.find((l) => l.user_id === COLEGA)!;
    const pendente = linhas.find((l) => l.user_id === CONVIDADO)!;

    expect(colega.profiles).toMatchObject({ name: "Colega", phone: "11 2222" });
    expect(pendente.profiles).toEqual({
      id: CONVIDADO, email: "vitima@x.com", name: null, phone: null, avatar_color: null, avatar_url: null,
    });
    expect(JSON.stringify(res.json())).not.toContain("11 9999");
  });

  it("quem não é membro não lista ninguém (sem ler perfis)", async () => {
    const app = await montarApp(membersRoutes);
    const res = await app.inject({ method: "GET", url: `/api/v1/members?workspace_id=${WS}`, headers: comoUsuario("estranho") });
    expect(res.statusCode).toBe(404);
    expect(falso.em("profiles")).toHaveLength(0);
  });
});

describe("convite de outra empresa não apaga nem desvia a conta (EQZ-56)", () => {
  beforeEach(() => {
    falso.limpar();
    falso.responder = (c) => {
      if (c.tabela === "workspace_members" && c.filtros.user_id === DONO && c.filtros.status === "ativo") return { data: papelDe(c) };
      if (c.tabela === "workspace_members" && c.filtros.status === "pendente") return { data: { id: "m3" } };
      if (c.tabela === "subscriptions") return { data: { status: "active", trial_ends_at: null, pause_starts_at: null, pause_ends_at: null } };
      if (c.tabela === "workspaces") return { data: { plan: "pro", name: "Mercado do Zé" } };
      return undefined;
    };
  });

  it("revogar um convite tira só a linha do convite, mesmo de quem nunca logou", async () => {
    falso.cliente.auth.admin.getUserById.mockResolvedValue({ data: { user: { id: CONVIDADO, last_sign_in_at: null } }, error: null } as never);
    const app = await montarApp(membersRoutes);
    const res = await app.inject({ method: "DELETE", url: `/api/v1/members/${CONVIDADO}/invite?workspace_id=${WS}`, headers: comoUsuario(DONO) });

    expect(res.statusCode).toBe(200);
    expect(falso.cliente.auth.admin.deleteUser).not.toHaveBeenCalled();
    expect(falso.em("workspace_members", "delete")).toEqual([
      expect.objectContaining({ filtros: expect.objectContaining({ id: "m3" }) }),
    ]);
  });

  it("o link do e-mail de convite diz qual workspace aceitar", async () => {
    process.env.ALLOWED_ORIGINS = "https://www.estoquizen.com.br";
    const app = await montarApp(membersRoutes);
    const res = await app.inject({
      method: "POST", url: "/api/v1/members/invite", headers: comoUsuario(DONO),
      payload: { email: "nova@x.com", role: "member", workspace_id: WS },
    });

    expect(res.statusCode).toBe(201);
    const [, opcoes] = falso.cliente.auth.admin.inviteUserByEmail.mock.calls[0] as [string, { redirectTo: string }];
    expect(opcoes.redirectTo).toBe(`https://www.estoquizen.com.br/auth/callback?workspace_id=${WS}`);
  });
});
