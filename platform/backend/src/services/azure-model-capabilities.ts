import type {
  AzureModelEvidence,
  AzureModelOperation,
} from "@archestra/shared/azure-models";
import { z } from "zod";
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
  if (!params.providerApiKeyId)
    return classifyAzureModelCapabilities(undefined);
  const rows =
    await LlmProviderApiKeyModelLinkModel.findCapabilitiesForApiKeyModels([
      params.providerApiKeyId,
    ]);
  return classifyAzureModelCapabilities(
    rows.find((row) => row.model.modelId === params.modelId),
  );
}

/** Explicit endpoints can defer unknown metadata to Azure; known incompatibility is rejected. */
export async function validateAzureModelOperation(params: {
  providerApiKeyId?: string;
  modelId: string;
  operation: AzureModelOperation;
  parameters?: Record<string, unknown>;
}): Promise<AzureModelCapabilities> {
  const evidence = await resolveAzureModelCapabilities(params);
  if (evidence.status !== "known") return evidence;
  if (!evidence.operations.includes(params.operation)) {
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
