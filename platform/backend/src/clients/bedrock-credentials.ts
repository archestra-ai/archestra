import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import config from "@/config";

export function isBedrockIamAuthEnabled(): boolean {
  return config.llm.bedrock.iamAuthEnabled;
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
