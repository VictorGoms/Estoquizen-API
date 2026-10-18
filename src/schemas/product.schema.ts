import { z } from "zod";
import { sanitizeText, sanitizeCode } from "../lib/sanitize.js";

const str = (max: number) => z.string().transform((v) => sanitizeText(v, max));

/* Preço com 2 casas e quantidades com 3 (o que a tela mostra e o banco guarda) */
const round = (casas: number) => (v: number) => Math.round(v * 10 ** casas) / 10 ** casas;

export const CreateProductSchema = z.object({
  name:         str(200).pipe(z.string().min(2, "Nome deve ter ao menos 2 caracteres")),
  code:         z.string().optional().nullable().transform((v) => (!v ? null : sanitizeCode(v) || null)),
  unit:         str(20).pipe(z.string().min(1, "Unidade é obrigatória")),
  price:        z.number().nonnegative("Preço não pode ser negativo").transform(round(2)),
  qty:          z.number().nonnegative("Quantidade não pode ser negativa").transform(round(3)).default(0),
  min_qty:      z.number().nonnegative().transform(round(3)).default(0),
  max_qty:      z.number().nonnegative().transform(round(3)).optional(),
  location:     str(200).optional(),
  supplier:     str(200).optional(),
  image_url:    z.nullable(z.string().url()).optional(),
  workspace_id: z.string().uuid("workspace_id inválido"),
});

export const UpdateProductSchema = CreateProductSchema.partial().omit({ workspace_id: true });

export const AdjustQtySchema = z.object({
  delta:  z.number().transform(round(3)).refine((d) => d !== 0, "A quantidade deve ser diferente de zero"),
  reason: str(300).optional(),
});

export type CreateProductInput = z.infer<typeof CreateProductSchema>;
export type UpdateProductInput = z.infer<typeof UpdateProductSchema>;
export type AdjustQtyInput     = z.infer<typeof AdjustQtySchema>;
