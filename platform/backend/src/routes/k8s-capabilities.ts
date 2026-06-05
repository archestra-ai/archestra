import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { getK8sCapabilities } from "@/k8s/capabilities";
import { constructResponseSchema, K8sCapabilitiesSchema } from "@/types";

const k8sCapabilitiesRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/k8s/capabilities",
    {
      schema: {
        operationId: RouteId.GetK8sCapabilities,
        description: "Inspect Kubernetes capabilities available to Archestra.",
        tags: ["Organization"],
        response: constructResponseSchema(K8sCapabilitiesSchema),
      },
    },
    async (_, reply) => {
      return reply.send(await getK8sCapabilities());
    },
  );
};

export default k8sCapabilitiesRoutes;
