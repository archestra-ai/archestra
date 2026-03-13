import { DocsPage, getDocsUrl } from "@shared";

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
