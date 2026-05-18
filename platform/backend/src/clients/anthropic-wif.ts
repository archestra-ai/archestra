import fs from "node:fs";
import config from "@/config";
import logger from "@/logging";

interface AnthropicTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

let cachedToken: string | null = null;
let tokenExpiry: number = 0;

export function isAnthropicWifEnabled(): boolean {
  return config.llm.anthropic.wif.enabled;
}

export async function getAnthropicWifToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  
  // Use cached token if it's still valid (with 5 min buffer)
  if (cachedToken && tokenExpiry > now + 300) {
    return cachedToken;
  }

  const { wif } = config.llm.anthropic;
  
  let identityToken = wif.identityToken;
  if (!identityToken && wif.identityTokenFile) {
    try {
      identityToken = fs.readFileSync(wif.identityTokenFile, "utf8").trim();
    } catch (error: any) {
      throw new Error(`Failed to read Anthropic identity token file: ${error.message}`);
    }
  }

  if (!identityToken) {
    throw new Error("Anthropic WIF is enabled but no identity token was provided.");
  }

  logger.info("Exchanging identity token for Anthropic access token...");

  try {
    const response = await fetch("https://api.anthropic.com/v1/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: identityToken,
        federation_rule_id: wif.ruleId,
        organization_id: wif.organizationId,
        service_account_id: wif.serviceAccountId,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Anthropic token exchange failed (${response.status}): ${errorBody}`);
    }

    const data = (await response.json()) as AnthropicTokenResponse;
    cachedToken = data.access_token;
    tokenExpiry = now + data.expires_in;

    return cachedToken;
  } catch (error: any) {
    logger.error(`Error during Anthropic WIF token exchange: ${error.message}`);
    throw error;
  }
}
