import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/lib/cleanup.js", () => ({ runCleanup: vi.fn(async () => ({ deleteErrors: [], emailErrors: [] })) }));
vi.mock("../src/lib/nfceMonitor.js", () => ({ diagnosticoNfce: vi.fn(async () => ({})) }));

const { cronAutorizado } = await import("../src/routes/admin/cleanup.js");

const SEGREDO = "c".repeat(40);

describe("/admin/*: só com o CRON_SECRET (EQZ-59)", () => {
  beforeEach(() => { process.env.CRON_SECRET = SEGREDO; });

  it("aceita só o Bearer com o segredo exato", () => {
    expect(cronAutorizado(`Bearer ${SEGREDO}`)).toBe(true);
    expect(cronAutorizado(`Bearer ${SEGREDO}x`)).toBe(false);
    expect(cronAutorizado(`Bearer ${SEGREDO.slice(1)}`)).toBe(false);
    expect(cronAutorizado(SEGREDO)).toBe(false);
    expect(cronAutorizado(undefined)).toBe(false);
  });

  it("sem a variável, ninguém entra (nem com o header vazio)", () => {
    delete process.env.CRON_SECRET;
    expect(cronAutorizado("Bearer ")).toBe(false);
    expect(cronAutorizado("Bearer qualquer")).toBe(false);
  });
});
