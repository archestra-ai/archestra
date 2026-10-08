import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { throwOnApiError } from "@/lib/utils/api";

export type DetectedMcpServer =
  archestraApiTypes.GetDetectedMcpServersResponses["200"][number];

/**
 * The MCP servers clients connected on their own, as the LLM proxy observed
 * them. Same endpoint permission as the installed-servers list, so viewers
 * without it get no request rather than a 403.
 */
export function useDetectedMcpServers() {
  const { data: canReadInstallations } = useHasPermissions({
    mcpServerInstallation: ["read"],
  });

  return useQuery({
    queryKey: ["mcp-servers", "detected"],
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getDetectedMcpServers();
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
    enabled: !!canReadInstallations,
  });
}
