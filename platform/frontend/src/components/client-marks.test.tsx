import { AGENT_CATALOG_IDS, type AgentCatalogId } from "@archestra/shared";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ClientIcon } from "@/app/connection/client-icon";
import { CONNECT_CLIENTS } from "@/app/connection/clients";
import { AgentIcon } from "@/components/agent-icon";
import { CATALOG_AGENT_ICONS } from "@/components/agent-icon.utils";
import { CatalogAgentIcon } from "@/components/agent-pages/agent-catalog";

/** The Connect page client of each agent catalog template. */
const CONNECT_CLIENT_ID: Record<AgentCatalogId, string> = {
  "claude-code": "claude-code",
  codex: "codex",
  opencode: "opencode",
  hermes: "hermes-agent",
  openclaw: "openclaw",
  grok: "grok-build",
  kimi: "kimi-code",
};

/** What a viewer sees of a drawn logo: its tile colour and its glyph. */
function drawnLogo(container: HTMLElement) {
  const tile = container.firstElementChild as HTMLElement | null;
  const glyph = tile?.querySelector("svg");
  return {
    background: tile?.style.background,
    viewBox: glyph?.getAttribute("viewBox"),
    paths: glyph?.innerHTML,
  };
}

describe.each(AGENT_CATALOG_IDS)("the %s logo", (id) => {
  it("is the same on the Connect page, on agents and in the agent catalog", () => {
    const client = CONNECT_CLIENTS.find(
      (candidate) => candidate.id === CONNECT_CLIENT_ID[id],
    );
    if (!client) throw new Error(`No Connect page client for ${id}`);

    const connect = drawnLogo(
      render(<ClientIcon client={client} size={20} />).container,
    );
    expect(connect.paths).toBeTruthy();
    expect(
      drawnLogo(
        render(<AgentIcon icon={CATALOG_AGENT_ICONS[id]} size={20} />)
          .container,
      ),
    ).toEqual(connect);
    expect(
      drawnLogo(render(<CatalogAgentIcon id={id} size={20} />).container),
    ).toEqual(connect);
  });
});
