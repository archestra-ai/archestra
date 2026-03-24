import { DocsPage, getDocsUrl } from "@shared";

export const DEFAULT_TABLE_LIMIT = 10;
export const DEFAULT_SORT_BY = "createdAt" as const;
export const DEFAULT_SORT_DIRECTION = "desc" as const;
export const DEFAULT_FILTER_ALL = "all" as const;

export const SHORTCUT_SEARCH = {
  key: "k",
  label: "K",
} as const;

export const SHORTCUT_NEW_CHAT = {
  code: "KeyN",
  label: "N",
} as const;

export const SHORTCUT_DELETE = {
  key: "d",
  label: "D",
} as const;

export const SHORTCUT_PIN = {
  key: "p",
  label: "P",
} as const;

export const SHORTCUT_SIDEBAR = {
  key: "b",
  label: "B",
} as const;

export const LOCAL_MCP_DISABLED_MESSAGE = (
  <>
    Unable to connect to Kubernetes cluster. Ensure K8s is running and the
    orchestrator configuration is correct. Try restarting the backend.{" "}
    <a
      href={getDocsUrl(DocsPage.PlatformOrchestrator)}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary hover:underline inline-flex items-center gap-1"
    >
      Learn more
    </a>
  </>
);

export const LOGS_LAYOUT_CONFIG = {
  title: "Logs",
  description:
    "Monitor LLM proxy requests and MCP tool call activity across your agents.",
  tabs: [
    { label: "LLM Proxy", href: "/llm/logs" },
    { label: "MCP Gateway", href: "/mcp/logs" },
  ],
};
