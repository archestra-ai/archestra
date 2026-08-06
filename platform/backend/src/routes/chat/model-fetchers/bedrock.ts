import { AwsV4Signer } from "aws4fetch";
import {
  decodeBedrockSigV4Marker,
  getBedrockCredentialProvider,
  getBedrockRegion,
} from "@/clients/bedrock-credentials";
import config from "@/config";
import {
  BEDROCK_EMBEDDING_MODELS,
  findBedrockEmbeddingModel,
} from "@/knowledge-base/embedding-clients/bedrock-models";
import logger from "@/logging";
import { joinBaseUrl } from "@/utils/base-url";
import { type ModelInfo, modelFetchError } from "./types";

export async function fetchBedrockModels(
  apiKey: string,
  baseUrlOverride?: string | null,
  extraHeaders?: Record<string, string> | null,
): Promise<ModelInfo[]> {
  const baseUrl = baseUrlOverride || config.llm.bedrock.baseUrl;
  if (!baseUrl) {
    logger.error("Bedrock base URL not configured");
    throw new Error("Bedrock base URL not configured");
  }

  const controlPlaneUrl = baseUrl.replace("-runtime", "");

  // SigV4 path: apiKey is a marker carrying static AWS credentials.
  const sigV4 = decodeBedrockSigV4Marker(apiKey);
  if (sigV4) {
    const region = getBedrockRegion(baseUrl);
    return discoverBedrockModels(controlPlaneUrl, extraHeaders ?? {}, {
      region,
      creds: sigV4,
    });
  }

  return discoverBedrockModels(controlPlaneUrl, {
    ...(extraHeaders ?? {}),
    Authorization: `Bearer ${apiKey}`,
  });
}

export async function fetchBedrockModelsViaIam(): Promise<ModelInfo[]> {
  const baseUrl = config.llm.bedrock.baseUrl;
  if (!baseUrl) {
    logger.warn("Bedrock base URL not configured");
    return [];
  }

  const controlPlaneUrl = baseUrl.replace("-runtime", "");
  const region = getBedrockRegion(baseUrl);
  const creds = await getBedrockCredentialProvider()();

  return discoverBedrockModels(controlPlaneUrl, {}, { region, creds });
}

/**
 * The models a Bedrock credential can actually run: cross-region and application
 * inference profiles, plus on-demand foundation models that have no profile, plus
 * the profile-less static embedding models.
 */
async function discoverBedrockModels(
  controlPlaneUrl: string,
  headers: Record<string, string>,
  iamParams?: BedrockIamSigningParams,
): Promise<ModelInfo[]> {
  // Sequential, not Promise.all: the profile listing paginates, so racing a
  // second endpoint against it interleaves requests for no real gain on what is
  // a background model sync.
  const profiles = await fetchAllBedrockInferenceProfiles(
    controlPlaneUrl,
    headers,
    iamParams,
  );
  const foundationModels = await fetchBedrockFoundationModels(
    controlPlaneUrl,
    headers,
    iamParams,
  );

  return mergeStaticEmbeddingModels(
    mergeOnDemandFoundationModels(
      mapInferenceProfilesToModels(profiles),
      foundationModels,
    ),
  );
}

interface BedrockInferenceProfile {
  inferenceProfileId?: string;
  inferenceProfileName?: string;
  status?: string;
  /**
   * The underlying foundation model(s) the profile routes to. AWS returns the
   * ARN(s) here; the foundation-model id is the authoritative canonical model
   * (the inference-profile id only encodes it for system/cross-region profiles,
   * not application inference profiles whose id is an opaque ARN).
   */
  models?: { modelArn?: string }[];
}

interface BedrockIamSigningParams {
  region: string;
  creds: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
}

async function fetchAllBedrockInferenceProfiles(
  controlPlaneUrl: string,
  headers: Record<string, string>,
  iamParams?: BedrockIamSigningParams,
): Promise<BedrockInferenceProfile[]> {
  const allProfiles: BedrockInferenceProfile[] = [];
  let nextToken: string | undefined;

  do {
    const params = new URLSearchParams({ maxResults: "1000" });
    if (nextToken) {
      params.set("nextToken", nextToken);
    }
    const url = joinBaseUrl(
      controlPlaneUrl,
      `/inference-profiles?${params.toString()}`,
    );

    const data = (await bedrockControlPlaneGet({
      url,
      headers,
      iamParams,
      resource: "inference profiles",
    })) as {
      inferenceProfileSummaries?: BedrockInferenceProfile[];
      nextToken?: string;
    };

    if (data.inferenceProfileSummaries) {
      allProfiles.push(...data.inferenceProfileSummaries);
    }

    nextToken = data.nextToken;
  } while (nextToken);

  logger.info(
    { profileCount: allProfiles.length },
    "[fetchBedrockInferenceProfiles] fetched inference profiles",
  );

  return allProfiles;
}

/**
 * A foundation model as returned by ListFoundationModels.
 * @see https://docs.aws.amazon.com/bedrock/latest/APIReference/API_ListFoundationModels.html
 */
interface BedrockFoundationModel {
  modelId?: string;
  modelName?: string;
  providerName?: string;
  outputModalities?: string[];
  inferenceTypesSupported?: string[];
  modelLifecycle?: { status?: string };
}

async function fetchBedrockFoundationModels(
  controlPlaneUrl: string,
  headers: Record<string, string>,
  iamParams?: BedrockIamSigningParams,
): Promise<BedrockFoundationModel[]> {
  // ListFoundationModels returns the whole catalog in one response — it takes no
  // pagination token, unlike /inference-profiles above.
  const url = joinBaseUrl(controlPlaneUrl, "/foundation-models");

  // Fails soft, unlike the inference-profile call. This is a second control-plane
  // permission (bedrock:ListFoundationModels) that credentials predating this
  // fallback may not carry, and it only ever *adds* models — so a denial must
  // leave the profile-derived list intact rather than break model sync outright.
  try {
    const data = (await bedrockControlPlaneGet({
      url,
      headers,
      iamParams,
      resource: "foundation models",
    })) as { modelSummaries?: BedrockFoundationModel[] };
    return data.modelSummaries ?? [];
  } catch (error) {
    logger.warn(
      { error },
      "[fetchBedrockModels] could not list foundation models; on-demand models without an inference profile will not be offered",
    );
    return [];
  }
}

/**
 * Add on-demand chat models that have no inference profile. AWS publishes system
 * inference profiles only for part of the catalog, so a model that is invocable
 * by its bare id (openai.gpt-oss-*, and other on-demand-only families) is absent
 * from /inference-profiles entirely and was therefore unselectable.
 *
 * Restricted to ON_DEMAND models because that is exactly the set callable by bare
 * model id; anything offered solely via INFERENCE_PROFILE is already covered by
 * the profile list, and listing its raw id would produce a model that 400s on use.
 */
function mergeOnDemandFoundationModels(
  discovered: ModelInfo[],
  foundationModels: BedrockFoundationModel[],
): ModelInfo[] {
  const allowedProviders = config.llm.bedrock.allowedProviders;
  const seen = new Set(discovered.map((model) => model.id));

  const injected = foundationModels
    .filter((model) => Boolean(model.modelId))
    .filter((model) => !seen.has(model.modelId as string))
    .filter((model) => (model.modelLifecycle?.status ?? "ACTIVE") === "ACTIVE")
    .filter((model) => model.inferenceTypesSupported?.includes("ON_DEMAND"))
    // ListFoundationModels carries the authoritative modality, so unlike the
    // profile path this needs no name-pattern guessing to exclude embedding,
    // image, and video models.
    .filter((model) => model.outputModalities?.includes("TEXT"))
    .filter((model) => {
      if (allowedProviders.length === 0) return true;
      return allowedProviders.some((provider) =>
        (model.modelId as string).startsWith(`${provider}.`),
      );
    })
    .map((model) => ({
      id: model.modelId as string,
      displayName: model.modelName
        ? `${model.modelName}${model.providerName ? ` (${model.providerName})` : ""}`
        : (model.modelId as string),
      provider: "bedrock" as const,
    }));

  if (injected.length > 0) {
    logger.info(
      { modelIds: injected.map((model) => model.id) },
      "[fetchBedrockModels] added on-demand foundation models with no inference profile",
    );
  }

  return injected.length > 0 ? [...discovered, ...injected] : discovered;
}

function mapInferenceProfilesToModels(
  profiles: BedrockInferenceProfile[],
): ModelInfo[] {
  const allowedProviders = config.llm.bedrock.allowedProviders;
  const allowedRegions = config.llm.bedrock.allowedInferenceRegions;

  const models = profiles
    .filter((profile) => profile.status === "ACTIVE")
    .filter((profile) => {
      if (allowedRegions.length === 0) return true;
      const id = profile.inferenceProfileId || "";
      const regionPrefix = id.split(".")[0];
      return allowedRegions.includes(regionPrefix);
    })
    .filter((profile) => {
      if (allowedProviders.length === 0) return true;
      const id = profile.inferenceProfileId || "";
      return allowedProviders.some((provider) => {
        const withoutRegion = id.replace(/^(us|eu|ap|global)\./, "");
        return withoutRegion.startsWith(`${provider}.`);
      });
    })
    .map((profile) => {
      const underlyingModelName = foundationModelIdFromArn(
        profile.models?.[0]?.modelArn,
      );
      const base = {
        id: profile.inferenceProfileId || "",
        displayName:
          profile.inferenceProfileName ||
          profile.inferenceProfileId ||
          "Unknown",
        provider: "bedrock" as const,
        // Authoritative underlying model for pricing — more robust than parsing
        // the inference-profile id (and the only signal for application profiles).
        ...(underlyingModelName ? { underlyingModelName } : {}),
      };

      // Classify supported embedding models instead of dropping them: tag with
      // their dimension so they flow to the embedding picker (and out of chat via
      // supportsTextChat). This surfaces profile-backed embedding models (Cohere)
      // region-accurately from the call we already make.
      const embedding =
        findBedrockEmbeddingModel(underlyingModelName ?? base.id) ??
        findBedrockEmbeddingModel(base.id);
      if (embedding) {
        return {
          ...base,
          capabilities: { embeddingDimensions: embedding.dimensions },
        };
      }

      return base;
    })
    .filter((model) => model.id)
    // Keep tagged embedding models; drop other non-chat models (rerankers, image/
    // video generators, and unsupported embedding models).
    .filter(
      (model) =>
        ("capabilities" in model &&
          model.capabilities?.embeddingDimensions != null) ||
        !isNonChatBedrockModel(model.id, model.underlyingModelName),
    );

  logger.info(
    {
      modelCount: models.length,
      allowedProviders: allowedProviders.length > 0 ? allowedProviders : "all",
      allowedInferenceRegions:
        allowedRegions.length > 0 ? allowedRegions : "all",
      models: models.map((model) => ({
        id: model.id,
        displayName: model.displayName,
      })),
    },
    "[fetchBedrockModels] models from inference profiles",
  );

  return models;
}

// Bedrock foundation-model families whose output is not chat text — embeddings,
// rerankers, and image/video generators. They can't serve chat completions, so
// listing one in the chat model picker lets a user select it and break every
// message. The inference-profiles endpoint this fetcher uses carries no
// modality (AWS ListFoundationModels holds the authoritative outputModalities
// but would cost a second control-plane call per sync), so classify by the
// stable model id / underlying foundation-model name. Fails open: an id that
// matches no pattern is kept, so a new chat family is never hidden.
const NON_CHAT_BEDROCK_MODEL_PATTERNS: RegExp[] = [
  /embed/i, // cohere.embed, amazon.titan-embed, twelvelabs.marengo-embed
  /rerank/i, // cohere.rerank
  /stable-image|stable-diffusion|sdxl|stability\./i, // Stability image models
  /titan-image|nova-canvas/i, // Amazon image generators
  /nova-reel|luma\./i, // video generators
];

function isNonChatBedrockModel(
  id: string,
  underlyingModelName?: string | null,
): boolean {
  // Match both the profile id and the underlying model name: application
  // inference profiles have opaque ids, so only the underlying name reveals the
  // family; system/cross-region profiles encode it in the id.
  const identifier = `${id} ${underlyingModelName ?? ""}`;
  return NON_CHAT_BEDROCK_MODEL_PATTERNS.some((pattern) =>
    pattern.test(identifier),
  );
}

/**
 * Extract the foundation-model id from a Bedrock model ARN, e.g.
 * `arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20240620-v1:0`
 * → `anthropic.claude-3-5-sonnet-20240620-v1:0`. Returns null for ARNs that
 * don't reference a foundation model (e.g. imported/custom models).
 */
function foundationModelIdFromArn(arn: string | undefined): string | null {
  if (!arn) {
    return null;
  }
  const marker = "foundation-model/";
  const index = arn.indexOf(marker);
  return index === -1 ? null : arn.slice(index + marker.length);
}

/**
 * Add the embedding models that have no inference profile (Amazon Titan) to the
 * discovered list. These are on-demand-only, so `/inference-profiles` never
 * returns them — they must be injected. Deduped by id so a model that ever does
 * gain a profile isn't listed twice. Honors the operator's Bedrock provider
 * allowlist.
 */
function mergeStaticEmbeddingModels(discovered: ModelInfo[]): ModelInfo[] {
  const seen = new Set(discovered.map((model) => model.id));
  const injected = bedrockStaticEmbeddingModels().filter(
    (model) => !seen.has(model.id),
  );
  return injected.length > 0 ? [...discovered, ...injected] : discovered;
}

function bedrockStaticEmbeddingModels(): ModelInfo[] {
  const allowedProviders = config.llm.bedrock.allowedProviders;
  return BEDROCK_EMBEDDING_MODELS.filter((model) => model.staticInject)
    .filter((model) => {
      if (allowedProviders.length === 0) return true;
      // Model ids are "<vendor>.<name>" (e.g. "amazon.titan-embed-text-v2:0").
      return allowedProviders.some((provider) =>
        model.modelId.startsWith(`${provider}.`),
      );
    })
    .map((model) => ({
      id: model.modelId,
      displayName: model.displayName,
      provider: "bedrock" as const,
      capabilities: { embeddingDimensions: model.dimensions },
    }));
}

/**
 * GET a Bedrock control-plane resource, signing with SigV4 when IAM credentials
 * are supplied and falling back to the caller's headers (bearer API key) otherwise.
 */
async function bedrockControlPlaneGet(params: {
  url: string;
  headers: Record<string, string>;
  iamParams?: BedrockIamSigningParams;
  resource: string;
}): Promise<unknown> {
  const { url, headers, iamParams, resource } = params;

  let response: Response;
  if (iamParams) {
    const signer = new AwsV4Signer({
      url,
      method: "GET",
      region: iamParams.region,
      accessKeyId: iamParams.creds.accessKeyId,
      secretAccessKey: iamParams.creds.secretAccessKey,
      sessionToken: iamParams.creds.sessionToken,
      service: "bedrock",
    });
    const signed = await signer.sign();
    response = await fetch(signed.url, { headers: signed.headers });
  } else {
    response = await fetch(url, { headers });
  }

  if (!response.ok) {
    const errorText = await response.text();
    const authType = iamParams ? "IAM" : "API key";
    logger.error(
      { status: response.status, error: errorText },
      `Failed to fetch Bedrock ${resource} via ${authType}`,
    );
    throw modelFetchError(`Bedrock ${resource}`, response.status);
  }

  return response.json();
}
