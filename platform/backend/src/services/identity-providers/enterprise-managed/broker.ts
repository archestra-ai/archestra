import type { TokenAuthContext } from "@/clients/mcp-client";
import logger from "@/logging";
import { resolveEnterpriseAssertion } from "@/services/identity-providers/enterprise-managed/assertion-resolver";
import { exchangeEnterpriseManagedCredential } from "@/services/identity-providers/enterprise-managed/exchange";
import type { EnterpriseManagedCredentialConfig } from "@/types";

export type ResolvedEnterpriseTransportCredential = {
  headerName: string;
  headerValue: string;
  expiresInSeconds: number | null;
};

export async function resolveEnterpriseTransportCredential(params: {
  agentId: string;
  tokenAuth?: TokenAuthContext;
  enterpriseManagedConfig: EnterpriseManagedCredentialConfig | null;
}): Promise<ResolvedEnterpriseTransportCredential | null> {
  const config = params.enterpriseManagedConfig;
  if (!config) {
    return null;
  }

  const assertion = await resolveEnterpriseAssertion({
    agentId: params.agentId,
    identityProviderId: config.identityProviderId,
    tokenAuth: params.tokenAuth,
  });
  if (!assertion) {
    logger.warn(
      {
        agentId: params.agentId,
        identityProviderId: config.identityProviderId,
        userId: params.tokenAuth?.userId,
      },
      "Unable to resolve enterprise assertion for enterprise-managed credential exchange",
    );
    return null;
  }

  const credential = await exchangeEnterpriseManagedCredential({
    identityProviderId: assertion.identityProviderId,
    assertion: assertion.assertion,
    enterpriseManagedConfig: config,
  });

  return normalizeEnterpriseTransportCredential({
    config,
    credential,
  });
}

function normalizeEnterpriseTransportCredential(params: {
  config: EnterpriseManagedCredentialConfig;
  credential: Awaited<ReturnType<typeof exchangeEnterpriseManagedCredential>>;
}): ResolvedEnterpriseTransportCredential {
  const { config, credential } = params;
  const scalarValue = extractInjectionValue({
    value: credential.value,
    responseFieldPath: config.responseFieldPath,
  });

  switch (config.tokenInjectionMode) {
    case "header":
      if (!config.headerName) {
        throw new Error(
          "Enterprise-managed credential injection mode 'header' requires headerName",
        );
      }
      return {
        headerName: config.headerName,
        headerValue: scalarValue,
        expiresInSeconds: credential.expiresInSeconds,
      };
    case "raw_authorization":
      return {
        headerName: "Authorization",
        headerValue: scalarValue,
        expiresInSeconds: credential.expiresInSeconds,
      };
    default:
      return {
        headerName: "Authorization",
        headerValue: `Bearer ${scalarValue}`,
        expiresInSeconds: credential.expiresInSeconds,
      };
  }
}

function extractInjectionValue(params: {
  value: string | Record<string, unknown>;
  responseFieldPath?: string;
}): string {
  if (typeof params.value === "string") {
    return params.value;
  }

  if (!params.responseFieldPath) {
    throw new Error(
      "Enterprise-managed credential response is structured; configure responseFieldPath to extract the credential value",
    );
  }

  const extracted = getValueAtPath(params.value, params.responseFieldPath);
  if (extracted === undefined) {
    throw new Error(
      `Enterprise-managed credential response field '${params.responseFieldPath}' did not resolve to a value`,
    );
  }

  if (typeof extracted !== "string") {
    throw new Error(
      `Enterprise-managed credential response field '${params.responseFieldPath}' did not resolve to a string`,
    );
  }

  return extracted;
}

function getValueAtPath(value: Record<string, unknown>, path: string): unknown {
  return path
    .split(".")
    .filter(Boolean)
    .reduce<unknown>((current, segment) => {
      if (isForbiddenPathSegment(segment)) {
        return undefined;
      }

      if (!current || typeof current !== "object" || Array.isArray(current)) {
        return undefined;
      }

      return (current as Record<string, unknown>)[segment];
    }, value);
}

function isForbiddenPathSegment(segment: string): boolean {
  return (
    segment === "__proto__" ||
    segment === "constructor" ||
    segment === "prototype"
  );
}
