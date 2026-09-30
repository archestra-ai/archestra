import config from "@/config";
import { ApiError } from "@/types";

export function assertMcpServiceAccountAllowed(
  serviceAccount: string | undefined,
): void {
  const effectiveServiceAccount = serviceAccount?.trim() || "default";
  if (
    config.orchestrator.kubernetes.allowedMcpServerServiceAccounts.includes(
      effectiveServiceAccount,
    )
  ) {
    return;
  }

  throw new ApiError(
    400,
    `Kubernetes service account "${effectiveServiceAccount}" is not allowed for MCP server workloads`,
  );
}
