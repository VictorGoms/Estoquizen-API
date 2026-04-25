import { z } from "zod";
import { sanitizeText, sanitizeCode } from "../lib/sanitize.js";

const str = (max: number) => z.string().transform((v) => sanitizeText(v, max));

export const CreateProductSchema = z.object({
  name:         str(200).pipe(z.string().min(2, "Nome deve ter ao menos 2 caracteres")),
  code:         z.string().optional().nullable().transform((v) => (!v ? null : sanitizeCode(v) || null)),
  unit:         str(20).pipe(z.string().min(1, "Unidade é obrigatória")),
  price:        z.number().nonnegative("Preço não pode ser negativo"),
  qty:          z.number().nonnegative("Quantidade não pode ser negativa").default(0),
  min_qty:      z.number().nonnegative().default(0),
  max_qty:      z.number().nonnegative().optional(),
  location:     str(200).optional(),
  supplier:     str(200).optional(),
  image_url:    z.nullable(z.string().url()).optional(),
  workspace_id: z.string().uuid("workspace_id inválido"),
});

export const UpdateProductSchema = CreateProductSchema.partial().omit({ workspace_id: true });

export const AdjustQtySchema = z.object({
  delta:  z.number(),
  reason: str(300).optional(),
});

export type CreateProductInput = z.infer<typeof CreateProductSchema>;
export type UpdateProductInput = z.infer<typeof UpdateProductSchema>;
export type AdjustQtyInput     = z.infer<typeof AdjustQtySchema>;
