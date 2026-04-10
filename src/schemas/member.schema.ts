import { z } from "zod";
import { sanitizeText, sanitizeEmail } from "../lib/sanitize.js";

export const InviteMemberSchema = z.object({
  email:        z.string().transform((v) => sanitizeEmail(v)).pipe(z.string().email("E-mail inválido")),
  name:         z.string().transform((v) => sanitizeText(v, 100)).optional(),
  role:         z.enum(["owner", "admin", "member"]),
  workspace_id: z.string().uuid("workspace_id inválido"),
});

export const UpdateMemberSchema = z.object({
  name:   z.string().transform((v) => sanitizeText(v, 100)).pipe(z.string().min(2)).optional(),
  phone:  z.string().transform((v) => sanitizeText(v, 20)).optional(),
  role:   z.enum(["owner", "admin", "member"]).optional(),
  status: z.enum(["ativo", "pendente", "inativo"]).optional(),
});

export type InviteMemberInput = z.infer<typeof InviteMemberSchema>;
export type UpdateMemberInput = z.infer<typeof UpdateMemberSchema>;
