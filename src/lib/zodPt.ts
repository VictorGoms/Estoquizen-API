import { z } from "zod";

/*
 * Mensagens padrão do Zod em português, com o nome do campo (antes chegavam ao usuário como
 * "Required" ou "Expected number, received string"). Schemas com mensagem própria continuam
 * usando a deles. Importado uma vez em server.ts.
 */
z.setErrorMap((issue, ctx) => {
  const campo = issue.path.length ? `O campo "${issue.path.join(".")}"` : "O valor";

  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      if (issue.received === "undefined" || issue.received === "null") {
        return { message: `${campo} é obrigatório.` };
      }
      return { message: `${campo} tem um tipo inválido.` };

    case z.ZodIssueCode.too_small:
      if (issue.type === "string") return { message: `${campo} deve ter ao menos ${issue.minimum} caracteres.` };
      if (issue.type === "array")  return { message: `${campo} deve ter ao menos ${issue.minimum} itens.` };
      if (issue.type === "number") {
        return { message: `${campo} deve ser ${issue.inclusive ? "maior ou igual a" : "maior que"} ${issue.minimum}.` };
      }
      break;

    case z.ZodIssueCode.too_big:
      if (issue.type === "string") return { message: `${campo} deve ter no máximo ${issue.maximum} caracteres.` };
      if (issue.type === "array")  return { message: `${campo} deve ter no máximo ${issue.maximum} itens.` };
      if (issue.type === "number") {
        return { message: `${campo} deve ser ${issue.inclusive ? "menor ou igual a" : "menor que"} ${issue.maximum}.` };
      }
      break;

    case z.ZodIssueCode.invalid_string:
      if (issue.validation === "email") return { message: "E-mail inválido." };
      return { message: `${campo} está em um formato inválido.` };

    case z.ZodIssueCode.invalid_enum_value:
      return { message: `${campo} é inválido. Valores aceitos: ${issue.options.join(", ")}.` };
  }

  return { message: ctx.defaultError };
});
