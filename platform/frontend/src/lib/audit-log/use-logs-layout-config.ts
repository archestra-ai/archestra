import { requiredPagePermissionsMap } from "@archestra/shared/access-control";
import { LOGS_LAYOUT_CONFIG } from "@/consts";
import { usePermissionMap } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";

export function useLogsLayoutConfig() {
  const permissionMap = usePermissionMap(requiredPagePermissionsMap);
  const openappaEnabled = useFeature("openappaEnabled");

  return {
    ...LOGS_LAYOUT_CONFIG,
    tabs: [
      { label: "LLM Proxy", href: "/llm/logs" },
      { label: "MCP Gateway", href: "/mcp/logs" },
      ...(permissionMap?.["/audit/logs"]
        ? [{ label: "Audit", href: "/audit/logs" }]
        : []),
      ...(openappaEnabled && permissionMap?.["/consults/logs"]
        ? [{ label: "Guardrail consults", href: "/consults/logs" }]
        : []),
    ],
  };
}
