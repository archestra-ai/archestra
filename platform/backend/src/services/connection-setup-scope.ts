import type { NativeSessionClientId } from "@archestra/shared/connection-setup";
import type { AppaSessionIdentity } from "@/openappa/wire";
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
