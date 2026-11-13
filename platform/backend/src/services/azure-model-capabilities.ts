import { getDocsUrl } from "@archestra/shared";
import {
  type AzureModelEvidence,
  type AzureModelOperation,
  isAzureAnthropicBackingModel,
} from "@archestra/shared/azure-models";
import { z } from "zod";
import { buildAzureFoundryAnthropicBaseUrl } from "@/clients/azure-url";
import config from "@/config";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import { ApiError } from "@/types/api";
import { azureCapabilityConfigurationHash } from "@/utils/azure-capability-scope";

export type AzureModelCapabilities =
  | (AzureModelEvidence & { status: "known" })
  | { status: "unknown" | "stale"; reason: string };

type LinkedCapabilities = Awaited<
  ReturnType<
    typeof LlmProviderApiKeyModelLinkModel.findCapabilitiesForApiKeyModels
  >
>[number];

/** Classify only this key's evidence. Global manual modality overrides are display metadata. */
export function classifyAzureModelCapabilities(
  row: LinkedCapabilities | undefined,
): AzureModelCapabilities {
  if (!row?.evidence || row.evidence.source !== "deployment") {
    return {
      status: "unknown",
      reason:
        "No resource deployment capability evidence. Refresh provider models.",
    };
  }
  const configuration = {
    ...row.configuration,
    baseUrl: row.configuration.baseUrl || config.llm.azure.baseUrl,
  };
  if (
    !row.syncedAt ||
    Date.now() - row.syncedAt.getTime() > 24 * 60 * 60 * 1000 ||
    row.evidence.configurationHash !==
      azureCapabilityConfigurationHash(configuration)
  ) {
    return {
      status: "stale",
      reason:
        "Deployment capabilities expired or provider configuration changed. Refresh provider models.",
    };
  }
  if (
    configuration.inferenceBaseUrl &&
    configuration.inferenceBaseUrl.replace(/\/+$/, "") !==
      configuration.baseUrl?.replace(/\/+$/, "")
  ) {
    return {
      status: "unknown",
      reason:
        "Discovery and inference use different endpoints; deployment identity is unconfirmed.",
    };
  }
  return { ...row.evidence, status: "known" };
}

/** Internal metadata lookup. The caller must authorize the selected provider key first. */
export async function resolveAzureModelCapabilities(params: {
  providerApiKeyId?: string;
  modelId: string;
}): Promise<AzureModelCapabilities> {
  return classifyAzureModelCapabilities(await findLinkedCapabilities(params));
}

/** Explicit endpoints can defer unknown metadata to Azure; known incompatibility is rejected. */
export async function validateAzureModelOperation(params: {
  providerApiKeyId?: string;
  modelId: string;
  operation: AzureModelOperation;
  parameters?: Record<string, unknown>;
}): Promise<AzureModelCapabilities> {
  const row = await findLinkedCapabilities(params);
  const evidence = classifyAzureModelCapabilities(row);
  if (evidence.status !== "known") return evidence;
  if (!evidence.operations.includes(params.operation)) {
    if (
      params.operation === "chat" &&
      isAzureAnthropicBackingModel({
        underlyingModelName: evidence.underlyingModelName,
      })
    ) {
      throw new ApiError(
        400,
        azureClaudeChatCompletionsGuidance({
          deployment: params.modelId,
          underlyingModelName: evidence.underlyingModelName,
          baseUrl: row?.configuration.baseUrl || config.llm.azure.baseUrl,
        }),
      );
    }
    throw new ApiError(
      400,
      `This Azure deployment does not support ${params.operation}; supported operations: ${evidence.operations.join(", ")}.`,
    );
  }
  if (
    (params.operation === "image-generation" ||
      params.operation === "image-edit") &&
    evidence.underlyingModelName
  ) {
    validateImageParameters({
      name: evidence.underlyingModelName.toLowerCase(),
      parameters: params.parameters ?? {},
      operation: params.operation,
    });
  }
  return evidence;
}

/**
 * What to do when a Claude deployment is called over Chat Completions, which
 * Microsoft Foundry answers with `404 api_not_supported`. Without an
 * `underlyingModelName` the deployment is not known to be Claude: Foundry's
 * answer is the only evidence.
 */
export function azureClaudeChatCompletionsGuidance(params: {
  deployment: string;
  underlyingModelName?: string | null;
  baseUrl?: string | null;
}): string {
  const { deployment, underlyingModelName } = params;
  const cause = !underlyingModelName
    ? `Azure deployment "${deployment}" does not serve the OpenAI Chat Completions API (Microsoft Foundry answered api_not_supported), which is how Foundry answers for Claude deployments.`
    : underlyingModelName.toLowerCase() === deployment.toLowerCase()
      ? `Azure deployment "${deployment}" is a Claude model, and Microsoft Foundry does not serve Claude over the OpenAI Chat Completions API.`
      : `Azure deployment "${deployment}" runs ${underlyingModelName}, a Claude model, and Microsoft Foundry does not serve Claude over the OpenAI Chat Completions API.`;
  const anthropicBaseUrl =
    buildAzureFoundryAnthropicBaseUrl(params.baseUrl) ??
    "https://<resource>.services.ai.azure.com/anthropic";
  return (
    `${cause} To fix it, either call the Responses API instead (POST /v1/model-router/responses on the Unified Model API), ` +
    `or add this Foundry resource as an Anthropic provider key with base URL ${anthropicBaseUrl}, map that key on your virtual key, and call "anthropic:${deployment}". ` +
    `Setup guide: ${getDocsUrl(ANTHROPIC_FOUNDRY_DOCS_PAGE, "anthropic-on-microsoft-foundry")}`
  );
}

function validateImageParameters(params: {
  name: string;
  parameters: Record<string, unknown>;
  operation: AzureModelOperation;
}) {
  const { name, parameters: body } = params;
  const has = (field: string) =>
    body[field] !== undefined && body[field] !== null;
  const reject = (field: string) => {
    throw new ApiError(
      400,
      `${field} is unsupported for this Azure backing model.`,
    );
  };
  if (name.startsWith("gpt-image-")) {
    for (const field of ["response_format", "style"])
      if (has(field)) reject(field);
    if (["standard", "hd"].includes(String(body.quality))) reject("quality");
    const newer = /^gpt-image-[2-9](?:[.-]|$)/.test(name);
    const extraQuality = /^gpt-image-2\.5-(?:sunburst|flare)(?:-|$)/.test(name);
    if (!extraQuality && ["xhigh", "max"].includes(String(body.quality)))
      reject("quality");
    if (
      !newer &&
      has("size") &&
      !["auto", "1024x1024", "1536x1024", "1024x1536"].includes(
        String(body.size),
      )
    )
      reject("size");
    if (name.includes("mini") && has("input_fidelity"))
      reject("input_fidelity");
  } else if (/^dall-e-[23]$/.test(name)) {
    for (const field of [
      "background",
      "output_format",
      "output_compression",
      "moderation",
      "input_fidelity",
    ])
      if (has(field)) reject(field);
    const sizes =
      name === "dall-e-3"
        ? ["1024x1024", "1792x1024", "1024x1792"]
        : ["256x256", "512x512", "1024x1024"];
    if (has("size") && !sizes.includes(String(body.size))) reject("size");
    if (
      has("quality") &&
      !(name === "dall-e-3" ? ["standard", "hd"] : ["standard"]).includes(
        String(body.quality),
      )
    )
      reject("quality");
    if (name === "dall-e-3" && has("n") && body.n !== 1) reject("n");
    if (name === "dall-e-2" && has("style")) reject("style");
    if (name === "dall-e-2" && params.operation === "image-edit") {
      // Only trusted upload metadata reaches this validator; the edit handler
      // owns decoding and validates the bytes before adding input_files.
      const files = z
        .object({
          images: z
            .array(
              z
                .object({
                  mime_type: z.literal("image/png"),
                  bytes: z
                    .number()
                    .int()
                    .positive()
                    .lt(4 * 1024 * 1024),
                  width: z.number().int().positive(),
                  height: z.number().int().positive(),
                })
                .refine((image) => image.width === image.height),
            )
            .length(1),
        })
        .safeParse(body.input_files);
      if (!files.success)
        throw new ApiError(
          400,
          "DALL-E 2 edits require exactly one square PNG smaller than 4 MiB.",
        );
    }
  }
}

async function findLinkedCapabilities(params: {
  providerApiKeyId?: string;
  modelId: string;
}): Promise<LinkedCapabilities | undefined> {
  if (!params.providerApiKeyId) return undefined;
  const rows =
    await LlmProviderApiKeyModelLinkModel.findCapabilitiesForApiKeyModels([
      params.providerApiKeyId,
    ]);
  return rows.find((row) => row.model.modelId === params.modelId);
}

const ANTHROPIC_FOUNDRY_DOCS_PAGE = "llm-proxy/providers/anthropic";
