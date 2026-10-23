import { describe, it, expect } from "vitest";

/* fotos.ts importa o cliente do Supabase, que exige endereço e chave; nada é chamado aqui */
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_ANON_KEY ??= "teste";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "teste";
const { pastasOrfas } = await import("../src/lib/fotos.js");

const VIVO   = "11111111-1111-4111-8111-111111111111";
const MORTO  = "22222222-2222-4222-8222-222222222222";

describe("fotos de workspaces excluídos (Storage fora do cascade)", () => {
  it("só a pasta de workspace que não existe mais é órfã", () => {
    expect(pastasOrfas([VIVO, MORTO], new Set([VIVO]))).toEqual([MORTO]);
  });

  it("pasta que não tem nome de workspace (UUID) nunca é apagada", () => {
    expect(pastasOrfas(["avatars", ".emptyFolderPlaceholder", "", "../" + MORTO], new Set())).toEqual([]);
  });

  it("sem pastas, nada a apagar", () => {
    expect(pastasOrfas([], new Set([VIVO]))).toEqual([]);
  });
});
