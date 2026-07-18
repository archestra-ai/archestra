import {
  type AmazonBedrockProvider,
  createAmazonBedrock,
} from "@ai-sdk/amazon-bedrock";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import config from "@/config";

export function isBedrockIamAuthEnabled(): boolean {
  return config.llm.bedrock.iamAuthEnabled;
}

/**
 * SigV4 static credentials encoded into the single `apiKey` string that flows
 * through the chat → proxy → provider pipeline. The marker keeps the wire
 * shape unchanged (one string), and only Bedrock-aware call sites decode it.
 */
const BEDROCK_SIGV4_MARKER = "aws-sigv4:";

export interface BedrockSigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export function encodeBedrockSigV4Marker(
  creds: BedrockSigV4Credentials,
): string {
  const json = JSON.stringify(creds);
  const b64 = Buffer.from(json, "utf8").toString("base64");
  return `${BEDROCK_SIGV4_MARKER}${b64}`;
}

export function decodeBedrockSigV4Marker(
  value: string | undefined,
): BedrockSigV4Credentials | null {
  if (!value || !value.startsWith(BEDROCK_SIGV4_MARKER)) return null;
  try {
    const b64 = value.slice(BEDROCK_SIGV4_MARKER.length);
    const json = Buffer.from(b64, "base64").toString("utf8");
    const parsed = JSON.parse(json) as Partial<BedrockSigV4Credentials>;
    if (!parsed.accessKeyId || !parsed.secretAccessKey) return null;
    return {
      accessKeyId: parsed.accessKeyId,
      secretAccessKey: parsed.secretAccessKey,
      sessionToken: parsed.sessionToken,
    };
  } catch {
    return null;
  }
}

export function getBedrockCredentialProvider(): () => Promise<{
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}> {
  const provider = fromNodeProviderChain();
  return async () => {
    const creds = await provider();
    return {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    };
  };
}

export function getBedrockRegion(baseUrl?: string): string {
  if (config.llm.bedrock.region) {
    return config.llm.bedrock.region;
  }
  const url = baseUrl || config.llm.bedrock.baseUrl;
  const match = url?.match(/bedrock-runtime\.([a-z0-9-]+)\./);
  return match?.[1] || "us-east-1";
}

/**
 * Build an Amazon Bedrock provider from the single `apiKey` string that flows
 * through the pipeline, applying the one canonical auth-precedence order used by
 * both chat (LLM proxy) and KB embedding:
 *   1. No apiKey + IAM auth enabled → dynamic credential provider (IRSA / instance
 *      profile / default AWS credential chain). A secretless key resolves to no
 *      apiKey, so IAM must win here — never fall through to bearer with a
 *      placeholder.
 *   2. apiKey carries a decoded SigV4 marker → static AWS credentials.
 *   3. Otherwise → bearer API-key auth.
 * Keeping this in one place stops the chat and embedding paths from drifting.
 */
export function buildBedrockProvider(params: {
  apiKey?: string | null;
  baseUrl?: string | null;
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
}): AmazonBedrockProvider {
  const { apiKey, baseUrl, headers, fetch } = params;
  const baseURL = baseUrl ?? config.llm.bedrock.baseUrl ?? undefined;
  const region = getBedrockRegion(baseURL ?? undefined);

  if (!apiKey && isBedrockIamAuthEnabled()) {
    return createAmazonBedrock({
      region,
      baseURL,
      credentialProvider: getBedrockCredentialProvider(),
      headers,
      fetch,
    });
  }

  const sigV4 = decodeBedrockSigV4Marker(apiKey ?? undefined);
  if (sigV4) {
    return createAmazonBedrock({
      region,
      baseURL,
      accessKeyId: sigV4.accessKeyId,
      secretAccessKey: sigV4.secretAccessKey,
      sessionToken: sigV4.sessionToken,
      headers,
      fetch,
    });
  }

  return createAmazonBedrock({
    apiKey: apiKey ?? undefined,
    region,
    baseURL,
    headers,
    fetch,
  });
}
