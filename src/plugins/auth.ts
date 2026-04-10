import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { supabaseAdmin } from "../lib/supabase.js";

/**
 * Extrai e verifica o JWT do Supabase no header Authorization.
 * Adiciona `request.user` com os dados do usuário autenticado.
 *
 * Uso nas rotas:
 *   { preHandler: [fastify.authenticate] }
 */
const authPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorate(
    "authenticate",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const authHeader = request.headers.authorization;

      if (!authHeader?.startsWith("Bearer ")) {
        return reply.status(401).send({ data: null, error: "Token não fornecido." });
      }

      const token = authHeader.slice(7);
      const { data, error } = await supabaseAdmin.auth.getUser(token);

      if (error || !data.user) {
        return reply.status(401).send({ data: null, error: "Token inválido ou expirado." });
      }

      request.user = data.user;
    },
  );
};

export default fp(authPlugin, { name: "auth" });

/* Augmenta o tipo do Fastify para reconhecer fastify.authenticate */
declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
