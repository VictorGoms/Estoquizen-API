import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { ok, fail, dbError, sendDbError } from "../../lib/response.js";
import { consultarNfce, NfceError, type NfceItem } from "../../lib/nfce.js";
import { linhasDoCatalogo } from "../../lib/catalogo.js";
import { registrarFalhaNfce } from "../../lib/nfceMonitor.js";
import { chaveValida } from "../../lib/nfeChave.js";
import { supabaseAdmin, supabaseForUser } from "../../lib/supabase.js";
import { sanitizeText, sanitizeCode, listaGrandeDemais } from "../../lib/sanitize.js";
import { requireMember } from "../../lib/membership.js";
import { assertActiveSubscription } from "../../lib/checkSubscription.js";
import { getLimits } from "../../lib/plans.js";

const chaveSchema = z.string()
  .transform((v) => v.replace(/\s/g, ""))
  .pipe(z.string().length(44, "Chave deve ter 44 dígitos").regex(/^\d+$/, "Chave deve conter apenas números"))
  /* O último dígito confere os outros 43: chave digitada errada não vai à SEFAZ */
  .refine(chaveValida, "Chave inválida: confira os números. O último dígito não bate com os anteriores.");

const ConsultarSchema = z.object({
  tipo:  z.enum(["nfce"]),
  chave: chaveSchema,
  workspace_id: z.string().uuid("workspace_id inválido"),
  /* Link lido do QR Code do cupom (2026-10-23): abre a nota sem captcha. A lib só aceita portal .gov.br
     com a mesma chave; fora disso é ignorado e vale a consulta pela chave */
  qr_url: z.string().max(1000).optional(),
});

/** Início do mês corrente no horário de Brasília (UTC-3, sem horário de verão desde 2019). */
function inicioDoMesBrasil(): string {
  const brt = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return new Date(Date.UTC(brt.getUTCFullYear(), brt.getUTCMonth(), 1, 3)).toISOString();
}

/* EQZ-27: o Basic lê até 2 notas de compra por mês (a RPC import_nota_fiscal confere de novo) */
async function assertNotaQuota(workspaceId: string, reply: FastifyReply): Promise<boolean> {
  const { data: ws } = await supabaseAdmin.from("workspaces").select("plan").eq("id", workspaceId).maybeSingle();
  const limits = getLimits(ws?.plan ?? "basic");
  if (limits.notasPorMes === null) return true;

  const { count, error } = await supabaseAdmin
    .from("nota_imports")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .gte("created_at", inicioDoMesBrasil());
  if (error) { reply.status(500).send(fail("Não foi possível conferir o limite de notas. Tente novamente.")); return false; }

  if ((count ?? 0) < limits.notasPorMes) return true;
  reply.status(403).send(fail(
    `O plano ${limits.label} lê até ${limits.notasPorMes} notas de compra por mês, e as deste mês já foram usadas. ` +
    `Para ler mais, mude para o Growth.`
  ));
  return false;
}

const MAX_ITENS_NOTA = 500;

/* Catálogo de códigos (EQZ-60): o que a própria API leu da SEFAZ vira nome confiável para as outras
   empresas (só GTIN de verdade + descrição + estado). Não atrasa a resposta; falha só vai para o log */
async function guardarNoCatalogo(itens: NfceItem[], uf: string, log: { error: (o: object, m: string) => void }) {
  try {
    const linhas = linhasDoCatalogo(itens, uf);
    if (!linhas.length) return;
    const { error } = await supabaseAdmin
      .from("catalogo_sefaz")
      .upsert(linhas, { onConflict: "codigo,nome", ignoreDuplicates: true });
    if (error) log.error({ err: error }, "falha ao guardar os itens da nota no catálogo");
  } catch (err) {
    log.error({ err }, "falha ao guardar os itens da nota no catálogo");
  }
}

const ImportarSchema = z.object({
  workspace_id: z.string().uuid("workspace_id inválido"),
  tipo:         z.enum(["nfce", "xml"]),
  chave:        chaveSchema.nullable().optional(),
  itens: z.array(z.object({
    product_id: z.string().uuid("Produto inválido").optional(),
    name:       z.string().transform((v) => sanitizeText(v, 200)).pipe(z.string().min(1, "Item sem nome")),
    code:       z.string().optional().nullable().transform((v) => (!v ? undefined : sanitizeCode(v) || undefined)),
    unit:       z.string().transform((v) => sanitizeText(v, 20)).optional(),
    price:      z.number().nonnegative("Preço não pode ser negativo").transform((v) => Math.round(v * 100) / 100).optional(),
    qty:        z.number().transform((v) => Math.round(v * 1000) / 1000).pipe(z.number().positive("Quantidade deve ser maior que zero")),
    /* O front ainda manda `manual` no item digitado (EQZ-34); o zod descarta. Nada daqui vai para o
       catálogo de códigos: estes itens vêm do navegador (EQZ-60) */
  })).min(1, "A nota não tem itens para importar").max(MAX_ITENS_NOTA, "Nota com itens demais"),
});

const nfeRoutes: FastifyPluginAsync = async (fastify) => {
  const authWrite = {
    preHandler: [fastify.authenticate],
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
  };

  /* POST /nfe/consultar */
  fastify.post("/nfe/consultar", authWrite, async (req, reply) => {
    const parsed = ConsultarSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(fail(parsed.error.errors[0].message));

    const { tipo, chave, workspace_id, qr_url } = parsed.data;

    /* Só owner/admin de um workspace com o recurso no plano (antes qualquer conta consultava) */
    if (!await requireMember(workspace_id, req.user.id, reply, ["owner", "admin"])) return;
    if (!await assertNotaQuota(workspace_id, reply)) return;

    try {
      if (tipo === "nfce") {
        const { itens, oficial } = await consultarNfce(chave, qr_url);
        if (itens.length === 0) {
          return reply.status(404).send(fail("Nenhum item encontrado. Verifique a chave e tente novamente."));
        }
        /* Só o que veio de portal oficial da SEFAZ: o link do QR aceita qualquer .gov.br */
        if (oficial) void guardarNoCatalogo(itens, chave.slice(0, 2), req.log);
        return reply.send(ok({ chave, total_itens: itens.length, itens }));
      }
    } catch (err) {
      if (err instanceof NfceError) {
        /* Guarda a falha e avisa o contato@ (lib/nfceMonitor.ts); a resposta não espera o e-mail */
        if (err.detalhe) void registrarFalhaNfce({ workspaceId: workspace_id, chave, qrUrl: qr_url, erro: err.message, detalhe: err.detalhe }, req.log);
        return reply.status(err.status).send(fail(err.message));
      }
      req.log.error({ err }, "falha inesperada na consulta da NFC-e");
      return reply.status(502).send(fail("Não foi possível consultar a nota agora. Tente de novo em alguns minutos."));
    }
  });

  /* POST /nfe/importar — importa a nota inteira numa transação (RPC import_nota_fiscal).
     Recusa a mesma chave no mesmo workspace (antes a nota repetida duplicava o estoque). */
  fastify.post("/nfe/importar", authWrite, async (req, reply) => {
    /* Antes do schema: lista enorme travava e podia derrubar a API (EQZ-59) */
    if (listaGrandeDemais(req.body, "itens", MAX_ITENS_NOTA)) return reply.status(400).send(fail("Nota com itens demais"));
    const parsed = ImportarSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(fail(parsed.error.errors[0].message));

    const { workspace_id, tipo, chave, itens } = parsed.data;

    if (!await requireMember(workspace_id, req.user.id, reply, ["owner", "admin"])) return;
    if (!await assertActiveSubscription(workspace_id, reply)) return;
    if (!await assertNotaQuota(workspace_id, reply)) return;

    /* Os produtos novos da nota contam no limite do plano */
    const novos = itens.filter((i) => !i.product_id).length;
    if (novos > 0) {
      const { data: ws } = await supabaseAdmin.from("workspaces").select("plan").eq("id", workspace_id).single();
      const limits = getLimits(ws?.plan ?? "basic");
      const { count } = await supabaseAdmin
        .from("products")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspace_id);

      if ((count ?? 0) + novos > limits.products) {
        return reply.status(403).send(fail(
          `Limite do plano ${limits.label}: a nota tem ${novos} produtos novos e o plano permite ${limits.products} ` +
          `(você já tem ${count ?? 0}). Faça upgrade ou remova itens da nota.`
        ));
      }
    }

    const token = req.headers.authorization!.slice(7);
    const db    = supabaseForUser(token);

    const { data, error } = await db.rpc("import_nota_fiscal", {
      p_workspace_id: workspace_id,
      p_chave:        chave ?? null,
      p_tipo:         tipo,
      p_itens:        itens,
    });

    if (error) {
      if (error.code === "23505") {
        return reply.status(409).send(fail(
          error.message.includes("já foi importada") ? error.message : "Esta nota já foi importada."
        ));
      }
      if (error.message.includes("Acesso negado")) return reply.status(403).send(fail("Acesso negado"));
      if (/Quantidade inválida|não encontrado|não tem itens/.test(error.message)) {
        return reply.status(400).send(fail(error.message));
      }
      req.log.error({ err: error, workspace_id }, "falha ao importar nota fiscal");
      return sendDbError(req, reply, error);
    }

    return reply.status(201).send(ok(data));
  });
};

export default nfeRoutes;
