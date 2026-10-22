import type { FastifyReply, FastifyRequest } from "fastify";
import type OpenAI from "openai";
import { toFile } from "openai";
import { z } from "zod";
import { isAzureOpenAiV1BaseUrl } from "@/clients/azure-url";
import config from "@/config";
import logger from "@/logging";
import { LimitValidationService } from "@/models/limit";
import ProxyProviderFileModel, {
  type ProxyFileScope,
} from "@/models/proxy-provider-file";
import { ApiError } from "@/types/api";
import {
  ProviderFileResponseSchema,
  type ProxyProviderFile,
} from "@/types/proxy-provider-file";
import { clientDisconnectSignal } from "@/utils/client-disconnect-signal";
import { azureAdapterFactory } from "./adapters/azure";
import { PROXY_BODY_LIMIT } from "./common";
import {
  type ProxyResourceCredential,
  resolveProxyResourceCredential,
} from "./llm-proxy-resource-auth";
import { getAzureProxyIngress } from "./utils/azure-ingress";
import { boundedMediaFetch } from "./utils/bounded-media-response";
import { parseMediaMultipart } from "./utils/media-multipart";
import { mediaProviderError } from "./utils/media-provider-error";

const ID_PREFIX = "file-archestra-";
export const ProxyFileIdSchema = z
  .string()
  .regex(
    /^file-archestra-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );
export const ProxyFileListQuerySchema = z
  .object({
    "api-version": z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    after: ProxyFileIdSchema.optional(),
    order: z.enum(["asc", "desc"]).default("desc"),
    purpose: z.literal("user_data").optional(),
  })
  .strict();

export async function createAzureProviderFile(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const context = await resourceContext(request, reply);
  if (config.llmProxy.usageAccountingMode === "enforce")
    throw new ApiError(
      422,
      "Authoritative provider file storage accounting is unavailable.",
    );
  const violation = await LimitValidationService.checkLimitsBeforeRequest({
    ...context.credential.limitContext,
    agentId: context.credential.agent.id,
    agent: context.credential.agent,
    unpricedMediaModel: "file-storage",
  });
  if (violation)
    throw new ApiError(
      429,
      "Provider file upload is blocked by the applicable usage or cost limit.",
    );
  const { fields, files } = await parseMediaMultipart(request, {
    fileFields: ["file"],
    maxFiles: 1,
    maxFileBytes: PROXY_BODY_LIMIT,
    maxTotalFileBytes: PROXY_BODY_LIMIT,
    maxFields: 3,
    maxFieldBytes: 128,
    maxParts: 4,
  });
  const values = z
    .object({
      purpose: z.literal("user_data"),
      "expires_after[anchor]": z.literal("created_at").optional(),
      "expires_after[seconds]": z.coerce
        .number()
        .int()
        .min(3600)
        .max(2_592_000)
        .optional(),
    })
    .strict()
    .safeParse(fields);
  if (!values.success || files.length !== 1 || !files[0].data.length)
    throw new ApiError(
      400,
      "Upload one nonempty file with purpose=user_data. Unsupported file purposes and fields are rejected.",
    );
  const anchor = values.data["expires_after[anchor]"];
  const seconds = values.data["expires_after[seconds]"];
  if (Boolean(anchor) !== Boolean(seconds))
    throw new ApiError(400, "Supply both expires_after anchor and seconds.");
  const file = files[0];
  const upload = await toFile(file.data, file.filename, {
    type: file.mimetype,
  });
  const raw = await providerCall(() =>
    context.client.files.create(
      {
        file: upload,
        purpose: "user_data",
        ...(anchor && seconds && { expires_after: { anchor, seconds } }),
      },
      { signal: context.signal },
    ),
  );
  try {
    const metadata = ProviderFileResponseSchema.parse(raw);
    if (
      !validRemoteId(metadata.id) ||
      metadata.bytes !== file.data.length ||
      (seconds && !metadata.expires_at) ||
      (metadata.expires_at && metadata.expires_at * 1000 <= Date.now())
    )
      throw new Error("Invalid provider file metadata");
    if (context.signal.aborted)
      throw new Error("Upload cancelled before file registration");
    const row = await ProxyProviderFileModel.create({
      ...context.scope,
      upstreamFileId: metadata.id,
      filename: file.filename,
      mimeType: file.mimetype,
      sizeBytes: file.data.length,
      purpose: "user_data",
      metadata,
      expiresAt: metadata.expires_at
        ? new Date(metadata.expires_at * 1000)
        : null,
    });
    return publicFile(row);
  } catch {
    if (validRemoteId(raw?.id)) {
      // Cleanup must survive the original caller's cancellation. Reuse only the
      // already resolved account; never reselect a credential after upload.
      const cleanupClient = createFileClient(
        context.credential,
        AbortSignal.timeout(10_000),
        context.ingress,
      );
      await cleanupClient.files.delete(raw.id).catch(() => {
        logger.warn(
          {
            providerApiKeyId:
              context.credential.providerAccount.providerApiKeyId,
          },
          "Provider file upload rollback failed; remote cleanup may be required.",
        );
      });
    }
    throw new ApiError(
      502,
      "Unable to register the uploaded provider file safely.",
    );
  }
}

export async function retrieveAzureProviderFile(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const context = await resourceContext(request, reply);
  const row = await ownedFile(request, context.scope);
  const raw = await providerCall(() =>
    context.client.files.retrieve(row.upstreamFileId, {
      signal: context.signal,
    }),
  );
  const parsed = ProviderFileResponseSchema.safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.id !== row.upstreamFileId ||
    parsed.data.bytes !== row.sizeBytes
  )
    throw new ApiError(502, "Invalid provider file metadata response.");
  if (parsed.data.expires_at && parsed.data.expires_at * 1000 <= Date.now())
    throw new ApiError(404, "Provider file not found.");
  return { ...parsed.data, id: ID_PREFIX + row.id, filename: row.filename };
}

export async function listAzureProviderFiles(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const context = await resourceContext(request, reply);
  const { limit, order, after } = ProxyFileListQuerySchema.parse(request.query);
  if (
    after &&
    !(await ProxyProviderFileModel.findOwned(
      after.slice(ID_PREFIX.length),
      context.scope,
    ))
  )
    throw new ApiError(404, "Provider file cursor not found.");
  const rows = await ProxyProviderFileModel.listOwned(context.scope, {
    limit: limit + 1,
    order,
    after: after?.slice(ID_PREFIX.length),
  });
  const data = rows.slice(0, limit).map(publicFile);
  return {
    object: "list" as const,
    data,
    first_id: data.at(0)?.id ?? null,
    last_id: data.at(-1)?.id ?? null,
    has_more: rows.length > limit,
  };
}

export async function contentAzureProviderFile(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const context = await resourceContext(request, reply);
  const row = await ownedFile(request, context.scope);
  const response = await providerCall(() =>
    context.client.files.content(row.upstreamFileId, {
      signal: context.signal,
    }),
  );
  if (!response || response.status === 204)
    throw new ApiError(
      409,
      "Provider file content is not available yet. Wait for processing before downloading.",
    );
  if (!(response instanceof Response))
    throw new ApiError(502, "Azure returned an invalid file content response.");
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length !== row.sizeBytes)
    throw new ApiError(
      502,
      "Provider file content does not match the uploaded file size.",
    );
  return reply
    .type("application/octet-stream")
    .header(
      "content-disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
    )
    .header("cache-control", "no-store")
    .send(data);
}

export async function deleteAzureProviderFile(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const context = await resourceContext(request, reply);
  const row = await ownedFile(request, context.scope);
  const result = await providerCall(() =>
    context.client.files.delete(row.upstreamFileId, { signal: context.signal }),
  );
  if (!result?.deleted || result.id !== row.upstreamFileId)
    throw new ApiError(502, "Provider did not confirm file deletion.");
  await ProxyProviderFileModel.deleteOwned(row.id, context.scope);
  return {
    id: ID_PREFIX + row.id,
    object: "file" as const,
    deleted: true as const,
  };
}

/** Scoped handles cannot be forwarded as native provider inference references. */
export function rejectUnsupportedProxyFileReferences(body: unknown): void {
  const pending = [body];
  const seen = new Set<object>();
  while (pending.length) {
    const current = pending.pop();
    if (
      !current ||
      typeof current !== "object" ||
      ArrayBuffer.isView(current) ||
      seen.has(current)
    )
      continue;
    seen.add(current);
    for (const [key, value] of Object.entries(current)) {
      if (
        key === "file_id" &&
        typeof value === "string" &&
        value.startsWith(ID_PREFIX)
      )
        throw new ApiError(
          400,
          "Provider file handles currently support file lifecycle operations only. Send image edits as multipart image files.",
        );
      if (value && typeof value === "object") pending.push(value);
    }
  }
}

async function resourceContext(request: FastifyRequest, reply: FastifyReply) {
  if (getAzureProxyIngress(request)?.deployment)
    throw new ApiError(
      400,
      "Files are resource-scoped and cannot use a deployment path.",
    );
  const signal = clientDisconnectSignal({ request, reply });
  const credential = await resolveProxyResourceCredential({
    request,
    provider: "azure",
    agentId: (request.params as { agentId?: string }).agentId,
    signal,
  });
  if (!isAzureOpenAiV1BaseUrl(credential.providerAccount.baseUrl))
    throw new ApiError(
      422,
      "Provider files require a configured Azure /openai/v1 account endpoint.",
    );
  const ingress = getAzureProxyIngress(request);
  const client = createFileClient(credential, signal, ingress);
  const scope: ProxyFileScope = {
    organizationId: credential.agent.organizationId,
    principalKind: credential.principal.kind,
    principalId: credential.principal.id,
    provider: "azure",
    accountBinding: credential.providerAccount.credentialBinding,
  };
  return { credential, scope, client, signal, ingress };
}

function createFileClient(
  credential: ProxyResourceCredential,
  signal: AbortSignal,
  ingress: ReturnType<typeof getAzureProxyIngress>,
) {
  const azure = azureAdapterFactory.createClient(credential.apiKey, {
    baseUrl: credential.providerAccount.baseUrl,
    source: "api",
    defaultHeaders: credential.defaultHeaders,
    abortSignal: signal,
    azureRequest: ingress,
  }) as { openai: OpenAI; fetch: typeof fetch };
  return azure.openai.withOptions({
    fetch: boundedMediaFetch(azure.fetch, PROXY_BODY_LIMIT),
    timeout: 60_000,
    maxRetries: 0,
  });
}

async function ownedFile(request: FastifyRequest, scope: ProxyFileScope) {
  const id = ProxyFileIdSchema.safeParse(
    (request.params as { fileId?: string }).fileId,
  );
  const row = id.success
    ? await ProxyProviderFileModel.findOwned(
        id.data.slice(ID_PREFIX.length),
        scope,
      )
    : null;
  if (!row) throw new ApiError(404, "Provider file not found.");
  return row;
}

function publicFile(row: ProxyProviderFile) {
  return ProviderFileResponseSchema.parse({
    ...row.metadata,
    id: ID_PREFIX + row.id,
    filename: row.filename,
    bytes: row.sizeBytes,
    purpose: row.purpose,
    object: "file",
  });
}

function validRemoteId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(id);
}

async function providerCall<T>(operation: () => PromiseLike<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw mediaProviderError(error, "file");
  }
}
