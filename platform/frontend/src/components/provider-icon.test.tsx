import {
  clientForExternalAgentIds,
  OPENCODE_FAMILY_CLIENT_IDS,
} from "@archestra/shared";
import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ClientIcon as ConnectTileIcon } from "@/app/connection/client-icon";
import { CONNECT_CLIENTS } from "@/app/connection/clients";
import { AgentIcon } from "@/app/connections/logs/_components/agent-icon";
import { ClientFilterOption } from "@/components/log-filter-option";
import { ClientIcon } from "./provider-icon";

describe("ClientIcon", () => {
  it("keeps Pi's identity in connected-agent history and the logs filter", () => {
    const family = clientForExternalAgentIds(["pi"]);
    if (!family) throw new Error("Pi is not a known client");
    const history = render(
      <AgentIcon agent={{ clientId: "pi", name: "Pi coding agent" }} />,
    );
    const filter = render(<ClientFilterOption client={family} />);
    const historyMark = within(history.container).getByRole("img", {
      name: "Pi logo",
    });
    const filterMark = within(filter.container).getByRole("img", {
      name: "Pi logo",
    });
    expect(historyMark.innerHTML).toBe(filterMark.innerHTML);
    expect(within(filter.container).getByText("Pi")).toBeVisible();
  });

  it.each([
    ...OPENCODE_FAMILY_CLIENT_IDS,
    "pi",
  ])("draws the %s client in the logs as its Connect tile does", (id) => {
    const family = clientForExternalAgentIds([id]);
    const tile = CONNECT_CLIENTS.find((client) => client.id === id);
    if (!family || !tile) throw new Error(`${id} is not a known client`);

    const logs = render(<ClientIcon client={family} size={16} />);
    const connect = render(<ConnectTileIcon client={tile} size={36} />);
    const logo = within(logs.container).getByRole("img", {
      name: `${family.label} logo`,
    });
    const tileLogo = within(connect.container).getByRole("img", {
      name: `${tile.label} logo`,
    });

    expect(logo.innerHTML).toBe(tileLogo.innerHTML);
    expect(logo.getAttribute("viewBox")).toBe(tileLogo.getAttribute("viewBox"));
    expect(logo.parentElement?.style.background).toBe(
      tileLogo.parentElement?.style.background,
    );
    // The brand tile keeps its colours in dark mode, like the Connect page.
    expect(logo.parentElement?.className).not.toContain("invert");
  });

  it.each([
    16, 20, 24,
  ])("identifies Pi by its official mark at %spx, not its model provider", (size) => {
    const family = clientForExternalAgentIds([" PI "]);
    if (!family) throw new Error("Pi is not a known client");
    const { container } = render(<ClientIcon client={family} size={size} />);
    const logo = within(container).getByRole("img", { name: "Pi logo" });
    expect(logo.getAttribute("viewBox")).toBe("0 0 560 560");
    expect(logo.querySelector("path")?.getAttribute("d")).toBe(
      "M420 280H280V140H0V0H420V280Z M560 560H420V280H560V560Z M140 560H0V140H140V280H280V420H140V560Z",
    );
    expect(logo.querySelector("path")?.getAttribute("fill")).toBe(
      "currentColor",
    );
    expect(
      within(container).queryByRole("img", { name: /OpenAI|Inflection/ }),
    ).toBeNull();
  });
});
