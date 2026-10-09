import type { NativeSessionClientId } from "@archestra/shared/connection-setup";
import type { AppaSessionIdentity } from "@/openappa/wire";
import { recognizeConnectionSetup } from "./connection-prompt-session";

type Principal = {
  userId?: string;
  organizationId?: string;
  targetOrganizationId: string;
  guardrailsActive: boolean;
};

type SetupEvidence = {
  kind: "native-session";
  identity: AppaSessionIdentity;
  requestBody: unknown;
};

type SetupScope = {
  kind: "native-session";
  userId: string;
  organizationId: string;
  clientId: NativeSessionClientId;
};

/** Resolve a native-session setup scope after ordinary authentication. */
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
