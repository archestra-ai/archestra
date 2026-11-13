import { render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { useChatAgentBootstrap } from "@/lib/agent.query";
import { useFeature } from "@/lib/config/config.query";
import { useAppaSelfService } from "@/lib/openappa-github-sync.query";
import { ServerRulesButton } from "./server-rules-launch";

vi.mock("@/lib/agent.query");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/openappa-github-sync.query");

const keeper = {
  id: "keeper-1",
  builtInAgentConfig: { name: "openappa-configuration-agent" },
};
const catalog = { id: "catalog-1", name: "Payments" };

beforeEach(() => {
  vi.mocked(useFeature).mockReturnValue(
    true as unknown as ReturnType<typeof useFeature>,
  );
  vi.mocked(useChatAgentBootstrap).mockReturnValue({
    data: [keeper],
  } as unknown as ReturnType<typeof useChatAgentBootstrap>);
});

test("links a server's editors to the Keeper while self-service is on", () => {
  vi.mocked(useAppaSelfService).mockReturnValue({
    data: { enabled: true },
  } as ReturnType<typeof useAppaSelfService>);
  render(<ServerRulesButton catalog={catalog}>Edit rules</ServerRulesButton>);
  const link = screen.getByRole("link", { name: "Edit rules" });
  const href = link.getAttribute("href") ?? "";
  expect(href).toContain("agentId=keeper-1");
  expect(decodeURIComponent(href.replaceAll("+", " "))).toContain(
    'Help me change the Guardrails rules of the MCP server "Payments"',
  );
});

test("shows nothing while self-service is off, as before the feature", () => {
  vi.mocked(useAppaSelfService).mockReturnValue({
    data: { enabled: false },
  } as ReturnType<typeof useAppaSelfService>);
  const { container } = render(
    <ServerRulesButton catalog={catalog}>Edit rules</ServerRulesButton>,
  );
  expect(container).toBeEmptyDOMElement();
  // The Keeper is not even looked up for it.
  expect(vi.mocked(useChatAgentBootstrap)).toHaveBeenCalledWith(false);
});
