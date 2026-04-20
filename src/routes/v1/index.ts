import type { FastifyPluginAsync } from "fastify";
import productsRoutes   from "./products.js";
import membersRoutes    from "./members.js";
import workspacesRoutes from "./workspaces.js";
import nfeRoutes        from "./nfe.js";
import billingRoutes    from "./billing.js";

const v1Routes: FastifyPluginAsync = async (fastify) => {
  fastify.register(productsRoutes);
  fastify.register(membersRoutes);
  fastify.register(workspacesRoutes);
  fastify.register(nfeRoutes);
  fastify.register(billingRoutes);

  /* Health check */
  fastify.get("/health", async () => ({ status: "ok", version: "v1" }));
};

export default v1Routes;
