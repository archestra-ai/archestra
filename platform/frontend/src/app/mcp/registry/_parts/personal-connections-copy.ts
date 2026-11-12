import { DESKTOP_MCP_COPY } from "@/lib/mcp/desktop-mcp";
import { DESKTOP_MCP_NO_TARGET_REASON } from "./desktop-mcp-install";
import { getLocalInstallationCopy } from "./local-installation-copy";
import type { CatalogServerType } from "./mcp-server-type";

/**
 * The words of the personal group of a server's connections. A desktop MCP
 * server lists the computers it was added to, a self-hosted server its
 * installations, and every other server the accounts connected to it.
 */
export function personalConnectionsCopy(params: {
  serverType: CatalogServerType | undefined;
  multitenant: boolean;
  /** The viewer sees only their own: "for me" then tells nothing apart. */
  isMemberView: boolean;
  /** A desktop MCP item with no command and no URL: nothing to add. */
  desktopNotSetUp: boolean;
}): {
  noun: "device" | "installation" | "credential";
  title: string;
  description: string;
  emptyText: string;
  add: string;
  adding: string;
} {
  const { serverType, multitenant, isMemberView, desktopNotSetUp } = params;
  if (serverType === "desktop_mcp") {
    return {
      noun: "device",
      title: DESKTOP_MCP_COPY.section,
      // The section already says who adds it; this says how it runs there.
      description: "It runs through the MCP bridge on that device.",
      emptyText: desktopNotSetUp
        ? DESKTOP_MCP_NO_TARGET_REASON
        : "No one has connected it from their device yet.",
      add: DESKTOP_MCP_COPY.add,
      adding: DESKTOP_MCP_COPY.adding,
    };
  }
  if (serverType === "local") {
    return {
      noun: "installation",
      title: "Personal installations",
      description: getLocalInstallationCopy(multitenant).personal,
      emptyText: "No personal installations yet.",
      add: isMemberView ? "Install" : "Install for me",
      adding: "Installing...",
    };
  }
  return {
    noun: "credential",
    title: "Personal connections",
    description: "Private to its owner — only that person can use it.",
    emptyText: "No personal connections yet.",
    add: "Connect my account",
    adding: "Installing...",
  };
}
