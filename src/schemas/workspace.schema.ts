import { z } from "zod";
import { sanitizeText } from "../lib/sanitize.js";

export const PLANS = ["basic", "growth", "pro"] as const;
export type Plan = (typeof PLANS)[number];

/* EQZ-13: "Qual é o seu negócio?" (mesmos valores do CHECK de workspaces.segment) */
export const SEGMENTOS = ["mercearia", "bar", "buffet", "roupas", "pet", "oficina", "outro"] as const;
const segment       = z.enum(SEGMENTOS, { errorMap: () => ({ message: "Segmento inválido" }) });
const segmentOther  = z.string().transform((v) => sanitizeText(v, 60));

export const CreateWorkspaceSchema = z.object({
  name:        z.string().transform((v) => sanitizeText(v, 100)).pipe(z.string().min(2, "Nome deve ter ao menos 2 caracteres")),
  description: z.string().transform((v) => sanitizeText(v, 300)).optional(),
  plan:        z.enum(PLANS).default("basic"),
  cpf:         z.string().optional(),
  segment:       segment.optional(),
  segment_other: segmentOther.optional(),
});

export const UpdateWorkspaceSchema = z.object({
  name:        z.string().transform((v) => sanitizeText(v, 100)).pipe(z.string().min(2)).optional(),
  description: z.string().transform((v) => sanitizeText(v, 300)).nullable().optional(),
  segment:       segment.nullable().optional(),
  segment_other: segmentOther.nullable().optional(),
});

export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceSchema>;
export type UpdateWorkspaceInput = z.infer<typeof UpdateWorkspaceSchema>;
