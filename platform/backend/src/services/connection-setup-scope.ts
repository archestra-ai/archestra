import type { NativeSessionClientId } from "@archestra/shared/connection-setup";
import type { AppaSessionIdentity } from "@/openappa/wire";
import { verifyConnectionSetupContext } from "./connection-setup-context";

type Principal = {
  userId?: string;
  organizationId?: string;
  targetOrganizationId: string;
  guardrailsActive: boolean;
};

type SetupEvidence = {
  kind: "approved-installer";
  token: string;
  gatewayId: string;
  signingSecret: string;
};

type SetupScope = {
  kind: "approved-installer";
  userId: string;
  organizationId: string;
  gatewayId: string;
};

/** Compose the installer's proof after ordinary authentication. */
export async function resolveConnectionSetupScope(params: {
  principal: Principal;
  evidence: SetupEvidence;
}): Promise<SetupScope | null> {
  const { userId, organizationId, targetOrganizationId, guardrailsActive } =
    params.principal;
  if (
    !guardrailsActive ||
    !userId ||
    !organizationId ||
    organizationId !== targetOrganizationId
  ) {
    return null;
  }

  if (
    !verifyConnectionSetupContext({
      token: params.evidence.token,
      userId,
      organizationId,
      gatewayId: params.evidence.gatewayId,
      secret: params.evidence.signingSecret,
    })
  ) {
    return null;
  }
  return {
    kind: "approved-installer",
    userId,
    organizationId,
    gatewayId: params.evidence.gatewayId,
  };
}

export function nativeSetupClientFromProvenance(
  provenance: AppaSessionIdentity["provenance"],
): NativeSessionClientId | undefined {
  return provenance ? PROVENANCE_TO_CLIENT_ID[provenance] : undefined;
}

const PROVENANCE_TO_CLIENT_ID: Partial<
  Record<NonNullable<AppaSessionIdentity["provenance"]>, NativeSessionClientId>
> = {
  "claude-code-header": "claude-code",
  "claude-code-metadata": "claude-code",
  "codex-turn-metadata": "codex",
  "opencode-session-header": "opencode",
  "opencode-hosted-header": "opencode",
};
