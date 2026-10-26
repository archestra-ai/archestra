import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { constructResponseSchema, UuidIdSchema } from "@/types/api";
import { ProviderFileResponseSchema } from "@/types/proxy-provider-file";
import { PROXY_BODY_LIMIT } from "../common";
import {
  contentAzureProviderFile,
  createAzureProviderFile,
  deleteAzureProviderFile,
  listAzureProviderFiles,
  ProxyFileIdSchema,
  ProxyFileListQuerySchema,
  retrieveAzureProviderFile,
} from "../provider-file-handler";

const azureFilesRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const parseJson = fastify.getDefaultJsonParser("error", "error");
  fastify.removeContentTypeParser("application/json");
  fastify.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (request, body, done) => {
      // Python's SDK sends an empty JSON DELETE without Content-Length.
      if (request.method === "DELETE" && body === "") done(null, undefined);
      else
        parseJson(
          request,
          typeof body === "string" ? body : body.toString(),
          done,
        );
    },
  );
  for (const withAgent of [false, true]) {
    const prefix = `/v1/azure${withAgent ? "/:agentId" : ""}/files`;
    const params = withAgent ? { agentId: UuidIdSchema } : {};
    const base = {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        tags: ["LLM Proxy"],
        ...(withAgent && { params: z.object(params) }),
      },
    };
    fastify.post(
      prefix,
      {
        ...base,
        schema: {
          ...base.schema,
          operationId: withAgent
            ? RouteId.AzureCreateFileWithAgent
            : RouteId.AzureCreateFile,
          description:
            "Upload a bounded user_data file to the uniquely selected Azure account. File handles are principal/account scoped and support lifecycle operations only.",
          consumes: ["multipart/form-data"],
          body: z.unknown().meta({
            type: "object",
            properties: {
              file: { type: "string", format: "binary" },
              purpose: { type: "string", enum: ["user_data"] },
              "expires_after[anchor]": { type: "string", enum: ["created_at"] },
              "expires_after[seconds]": {
                type: "integer",
                minimum: 3600,
                maximum: 2_592_000,
              },
            },
            required: ["file", "purpose"],
            additionalProperties: false,
          }),
          response: constructResponseSchema(ProviderFileResponseSchema),
        },
      },
      createAzureProviderFile,
    );
    fastify.get(
      prefix,
      {
        ...base,
        schema: {
          ...base.schema,
          operationId: withAgent
            ? RouteId.AzureListFilesWithAgent
            : RouteId.AzureListFiles,
          querystring: ProxyFileListQuerySchema,
          response: constructResponseSchema(
            z.object({
              object: z.literal("list"),
              data: z.array(ProviderFileResponseSchema),
              first_id: z.string().nullable(),
              last_id: z.string().nullable(),
              has_more: z.boolean(),
            }),
          ),
        },
      },
      listAzureProviderFiles,
    );
    fastify.get(
      `${prefix}/:fileId`,
      {
        ...base,
        schema: {
          ...base.schema,
          operationId: withAgent
            ? RouteId.AzureRetrieveFileWithAgent
            : RouteId.AzureRetrieveFile,
          params: z.object({ ...params, fileId: ProxyFileIdSchema }),
          response: constructResponseSchema(ProviderFileResponseSchema),
        },
      },
      retrieveAzureProviderFile,
    );
    fastify.get(
      `${prefix}/:fileId/content`,
      {
        ...base,
        schema: {
          ...base.schema,
          operationId: withAgent
            ? RouteId.AzureFileContentWithAgent
            : RouteId.AzureFileContent,
          params: z.object({ ...params, fileId: ProxyFileIdSchema }),
          produces: ["application/octet-stream"],
          response: {
            200: z.unknown().meta({ type: "string", format: "binary" }),
          },
        },
      },
      contentAzureProviderFile,
    );
    fastify.delete(
      `${prefix}/:fileId`,
      {
        ...base,
        schema: {
          ...base.schema,
          operationId: withAgent
            ? RouteId.AzureDeleteFileWithAgent
            : RouteId.AzureDeleteFile,
          params: z.object({ ...params, fileId: ProxyFileIdSchema }),
          response: constructResponseSchema(
            z.object({
              id: z.string(),
              object: z.literal("file"),
              deleted: z.literal(true),
            }),
          ),
        },
      },
      deleteAzureProviderFile,
    );
  }
};
export default azureFilesRoutes;
