import { defineConfig } from "vitest/config";

/* Testes das regras puras (npm test). Ficam em test/, fora do src/ que o tsc compila para o Railway. */
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
