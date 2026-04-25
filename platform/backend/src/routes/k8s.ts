import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { McpServerRuntimeManager } from "@/k8s/mcp-server-runtime";
import { constructResponseSchema } from "@/types";

const k8sRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/k8s/namespaces",
    {
      schema: {
        operationId: RouteId.ListK8sNamespaces,
        description: "List available Kubernetes namespaces in the cluster",
        tags: ["K8s"],
        response: constructResponseSchema(
          z.object({
            namespaces: z.array(z.string()),
            defaultNamespace: z.string(),
          }),
        ),
      },
    },
    async (_request, reply) => {
      const namespaces = await McpServerRuntimeManager.listNamespaces();
      const defaultNamespace = McpServerRuntimeManager.getDefaultNamespace();
      return reply.send({ namespaces, defaultNamespace });
    },
  );
};

export default k8sRoutes;
