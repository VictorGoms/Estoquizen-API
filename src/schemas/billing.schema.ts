import { z } from "zod";
import { sanitizeText } from "../lib/sanitize.js";

/* EQZ-07: a única pergunta do cancelamento (mesmos valores do CHECK de cancel_feedback.motivo) */
export const MOTIVOS_CANCELAMENTO = ["caro", "pouco_uso", "negocio_parado", "faltou_recurso", "outro_sistema", "outro"] as const;

export const CancelFeedbackSchema = z.object({
  workspace_id: z.string().uuid("workspace_id inválido"),
  motivo:       z.enum(MOTIVOS_CANCELAMENTO, { errorMap: () => ({ message: "Motivo inválido" }) }),
  detalhe:      z.string().max(500, "Conte em até 500 caracteres").transform((v) => sanitizeText(v)).optional(),
  acao:         z.enum(["cancelar", "pausar", "trocar_plano"], { errorMap: () => ({ message: "Ação inválida" }) }),
});
