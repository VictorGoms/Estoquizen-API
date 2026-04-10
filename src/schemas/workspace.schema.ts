import { z } from "zod";
import { sanitizeText } from "../lib/sanitize.js";

export const PLANS = ["basic", "intermediate", "pro"] as const;
export type Plan = (typeof PLANS)[number];

export const CreateWorkspaceSchema = z.object({
  name:        z.string().transform((v) => sanitizeText(v, 100)).pipe(z.string().min(2, "Nome deve ter ao menos 2 caracteres")),
  description: z.string().transform((v) => sanitizeText(v, 300)).optional(),
  plan:        z.enum(PLANS).default("basic"),
});

export const UpdateWorkspaceSchema = z.object({
  name:        z.string().transform((v) => sanitizeText(v, 100)).pipe(z.string().min(2)).optional(),
  description: z.string().transform((v) => sanitizeText(v, 300)).nullable().optional(),
});

export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceSchema>;
export type UpdateWorkspaceInput = z.infer<typeof UpdateWorkspaceSchema>;
