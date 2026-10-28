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
  /* Custo de compra (EQZ-23), opcional; null limpa */
  cost:         z.nullable(z.number().nonnegative("Custo não pode ser negativo").transform(round(2))).optional(),
  qty:          z.number().nonnegative("Quantidade não pode ser negativa").transform(round(3)).default(0),
  min_qty:      z.number().nonnegative().transform(round(3)).default(0),
  max_qty:      z.number().nonnegative().transform(round(3)).optional(),
  location:     z.nullable(str(200)).optional(),  /* null limpa o campo */
  category:     str(60).optional(),
  supplier:     z.nullable(str(200)).optional(),
  image_url:    z.nullable(z.string().url()).optional(),
  /* EQZ-30: ícone escolhido à mão ("nenhum" = só iniciais); null volta para o automático pelo nome */
  icon:         z.nullable(z.string().regex(/^[a-z]{2,20}$/, "Ícone inválido")).optional(),
  workspace_id: z.string().uuid("workspace_id inválido"),
});

/* Sem qty: estoque só muda por /adjust, que grava a movimentação (o PATCH mudava sem histórico) */
export const UpdateProductSchema = CreateProductSchema.partial().omit({ workspace_id: true, qty: true });

/* Contagem do dia (EQZ-17): quanto a pessoa contou na prateleira */
export const CountSchema = z.object({
  counted: z.number().nonnegative("A quantidade contada não pode ser negativa").transform(round(3)),
});

/* Motivos de saída (EQZ-23). "ajuste_contagem" só a contagem do dia grava */
export const MOTIVOS_SAIDA = ["venda", "perda", "vencido", "furto", "uso_interno", "devolucao"] as const;

export const AdjustQtySchema = z.object({
  delta:  z.number().transform(round(3)).refine((d) => d !== 0, "A quantidade deve ser diferente de zero"),
  reason: str(300).optional(),
  /* Só vale na saída; sem ele a saída fica como "venda" */
  motivo: z.enum(MOTIVOS_SAIDA).optional(),
});

/* Entrada ou saída de vários produtos de uma vez (EQZ-69, modo "Vários" do Escanear). A quantidade
   vai sempre positiva; o tipo diz o sentido. Sem produto repetido: a tela soma antes de mandar */
export const MAX_LOTE = 300;
export const AdjustBatchSchema = z.object({
  workspace_id: z.string().uuid("workspace_id inválido"),
  tipo:   z.enum(["entrada", "saida"], { errorMap: () => ({ message: "Tipo inválido" }) }),
  motivo: z.enum(MOTIVOS_SAIDA).optional(),
  reason: str(300).optional(),
  itens:  z.array(z.object({
    product_id: z.string().uuid("Produto inválido"),
    qty:        z.number().transform(round(3)).refine((q) => q > 0 && q <= 999_999_999, "Quantidade inválida"),
  }))
    .min(1, "A lista está vazia")
    .max(MAX_LOTE, `Até ${MAX_LOTE} produtos por vez`)
    .refine((l) => new Set(l.map((i) => i.product_id)).size === l.length, "Produto repetido na lista"),
});

/* Importação de planilha (EQZ-14): o front lê o arquivo e manda os produtos já mapeados.
   O teto evita estourar as colunas numeric(12,x) do banco. */
const MAX_NUM = 999_999_999;
const numImport = (casas: number) =>
  z.number().nonnegative("Número negativo na planilha").max(MAX_NUM, "Número grande demais na planilha").transform(round(casas));

/* Teto da importação de planilha; a rota confere antes do schema (listaGrandeDemais) */
export const MAX_IMPORTACAO = 2000;

export const ImportProductsSchema = z.object({
  workspace_id: z.string().uuid("workspace_id inválido"),
  itens: z.array(z.object({
    name:     str(200).pipe(z.string().min(2, "Todo produto precisa de um nome com ao menos 2 letras")),
    code:     z.string().optional().nullable().transform((v) => (!v ? null : sanitizeCode(v) || null)),
    unit:     z.nullable(str(20)).optional(),
    qty:      numImport(3).optional(),
    price:    numImport(2).optional(),
    cost:     z.nullable(numImport(2)).optional(),
    min_qty:  numImport(3).optional(),
    max_qty:  z.nullable(numImport(3)).optional(),
    category: z.nullable(str(60)).optional(),
    supplier: z.nullable(str(200)).optional(),
    location: z.nullable(str(200)).optional(),
  })).min(1, "A planilha não tem produtos para importar").max(MAX_IMPORTACAO, `Importe até ${MAX_IMPORTACAO} produtos por vez`),
});

export type CreateProductInput = z.infer<typeof CreateProductSchema>;
export type UpdateProductInput = z.infer<typeof UpdateProductSchema>;
export type AdjustQtyInput     = z.infer<typeof AdjustQtySchema>;
