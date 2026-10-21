import { z } from "zod";

/* Lista de compras: item adicionado à mão (um por produto; mandar de novo troca a quantidade) */
export const ShoppingItemSchema = z.object({
  workspace_id: z.string().uuid("workspace_id inválido"),
  product_id:   z.string().uuid("Produto inválido"),
  qty:          z.number().positive("A quantidade precisa ser maior que zero").max(999_999_999, "Quantidade grande demais")
    .transform((v) => Math.round(v * 1000) / 1000),
});
