import { describe, it, expect } from "vitest";
import { pausaEmAndamento, somarMeses } from "../src/lib/pausa.js";

const ISO = (s: string) => new Date(s).toISOString();
const t = (s: string) => new Date(s).getTime();

describe("pausa da assinatura (EQZ-07)", () => {
  const sub = { pause_starts_at: ISO("2026-11-20T06:50:57Z"), pause_ends_at: ISO("2026-12-20T06:50:57Z") };

  it("bloqueia só entre o fim do mês pago e o fim da pausa", () => {
    expect(pausaEmAndamento(sub, t("2026-11-19T12:00:00Z"))).toBe(false);
    expect(pausaEmAndamento(sub, t("2026-11-20T06:50:57Z"))).toBe(true);
    expect(pausaEmAndamento(sub, t("2026-12-10T00:00:00Z"))).toBe(true);
    expect(pausaEmAndamento(sub, t("2026-12-20T06:50:57Z"))).toBe(false);
  });

  it("sem pausa gravada não bloqueia", () => {
    expect(pausaEmAndamento({ pause_starts_at: null, pause_ends_at: null })).toBe(false);
    expect(pausaEmAndamento({})).toBe(false);
  });

  it("soma meses de calendário como o ciclo mensal", () => {
    const fimPago = t("2026-11-20T06:50:57Z") / 1000;
    expect(new Date(somarMeses(fimPago, 1) * 1000).toISOString()).toBe("2026-12-20T06:50:57.000Z");
    expect(new Date(somarMeses(fimPago, 2) * 1000).toISOString()).toBe("2027-01-20T06:50:57.000Z");
    expect(somarMeses(fimPago, 0)).toBe(fimPago);
  });
});
