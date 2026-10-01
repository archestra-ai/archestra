import type { NativeSessionClientId } from "@archestra/shared/connection-setup";
import type { AppaSessionIdentity } from "@/openappa/wire";
import { recognizeConnectionSetup } from "./connection-prompt-session";
import { verifyConnectionSetupContext } from "./connection-setup-context";

type Principal = {
  userId?: string;
  organizationId?: string;
  targetOrganizationId: string;
  guardrailsActive: boolean;
};

type SetupEvidence =
  | {
      kind: "native-session";
      identity: AppaSessionIdentity;
      requestBody: unknown;
    }
  | {
      kind: "approved-installer";
      token: string;
      gatewayId: string;
      signingSecret: string;
    };

type SetupScope =
  | {
      kind: "native-session";
      userId: string;
      organizationId: string;
      clientId: NativeSessionClientId;
    }
  | {
      kind: "approved-installer";
      userId: string;
      organizationId: string;
      gatewayId: string;
    };

/** Compose the proof for either surface after ordinary authentication. */
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

  if (params.evidence.kind === "native-session") {
    const clientId = nativeSetupClientFromProvenance(
      params.evidence.identity.provenance,
    );
    const sessionId = params.evidence.identity.sessionId;
    if (
      !clientId ||
      !sessionId ||
      !(await recognizeConnectionSetup({
        userId,
        organizationId,
        sessionId,
        clientId,
        requestBody: params.evidence.requestBody,
      }))
    ) {
      return null;
    }
    return { kind: "native-session", userId, organizationId, clientId };
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
