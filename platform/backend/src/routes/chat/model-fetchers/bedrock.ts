import { AwsV4Signer } from "aws4fetch";
import {
  decodeBedrockSigV4Marker,
  getBedrockCredentialProvider,
  getBedrockRegion,
} from "@/clients/bedrock-credentials";
import config from "@/config";
import logger from "@/logging";
import { joinBaseUrl } from "@/utils/base-url";
import type { ModelInfo } from "./types";

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
    const profiles = await fetchAllBedrockInferenceProfiles(
      controlPlaneUrl,
      extraHeaders ?? {},
      { region, creds: sigV4 },
    );
    return mapInferenceProfilesToModels(profiles);
  }

  const profiles = await fetchAllBedrockInferenceProfiles(controlPlaneUrl, {
    ...(extraHeaders ?? {}),
    Authorization: `Bearer ${apiKey}`,
  });

  return mapInferenceProfilesToModels(profiles);
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

  const profiles = await fetchAllBedrockInferenceProfiles(
    controlPlaneUrl,
    {},
    { region, creds },
  );

  return mapInferenceProfilesToModels(profiles);
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
        `Failed to fetch Bedrock inference profiles via ${authType}`,
      );
      throw new Error(
        `Failed to fetch Bedrock inference profiles: ${response.status}`,
      );
    }

    const data = (await response.json()) as {
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
    .map((profile) => ({
      id: profile.inferenceProfileId || "",
      displayName:
        profile.inferenceProfileName || profile.inferenceProfileId || "Unknown",
      provider: "bedrock" as const,
      // Authoritative underlying model for pricing — more robust than parsing
      // the inference-profile id (and the only signal for application profiles).
      ...(foundationModelIdFromArn(profile.models?.[0]?.modelArn)
        ? {
            underlyingModelName: foundationModelIdFromArn(
              profile.models?.[0]?.modelArn,
            ),
          }
        : {}),
    }))
    .filter((model) => model.id);

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
