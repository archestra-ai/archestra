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
