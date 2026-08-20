import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AgentSelector, type AgentSelectorAgent } from "./agent-selector";

const personalProxy: AgentSelectorAgent = {
  id: "p1",
  name: "My Proxy",
  agentType: "llm_proxy",
  scope: "personal",
  authorEmail: "owner@example.com",
};

const orgProxy: AgentSelectorAgent = {
  id: "p2",
  name: "Shared Proxy",
  agentType: "llm_proxy",
  scope: "org",
  description: "Shared across the org",
};

beforeAll(() => {
  // Radix Popover + cmdk reach for these APIs jsdom doesn't implement.
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

describe("AgentSelector (single, flat)", () => {
  it("shows the selected personal item's owner email beneath its name", () => {
    render(
      <AgentSelector
        mode="single"
        flat
        agents={[personalProxy, orgProxy]}
        value="p1"
        onValueChange={vi.fn()}
      />,
    );

    expect(screen.getByText("My Proxy")).toBeInTheDocument();
    expect(screen.getByText("owner@example.com")).toBeInTheDocument();
  });

  it("omits the owner email for a non-personal selection", () => {
    render(
      <AgentSelector
        mode="single"
        flat
        agents={[personalProxy, orgProxy]}
        value="p2"
        onValueChange={vi.fn()}
      />,
    );

    expect(screen.getByText("Shared Proxy")).toBeInTheDocument();
    expect(screen.queryByText("owner@example.com")).not.toBeInTheDocument();
  });

  // The dropdown row has room for the description; the trigger is a compact
  // control that has to stay one value tall.
  it("shows an agent's description in its dropdown row but not in the trigger", async () => {
    const user = userEvent.setup();
    render(
      <AgentSelector
        mode="single"
        flat
        agents={[personalProxy, orgProxy]}
        value="p2"
        onValueChange={vi.fn()}
      />,
    );

    expect(
      within(screen.getByRole("combobox")).queryByText("Shared across the org"),
    ).toBeNull();

    await user.click(screen.getByRole("combobox"));

    const option = await screen.findByRole("option", { name: /Shared Proxy/ });
    expect(within(option).getByText("Shared across the org")).toBeVisible();
  });

  // The selection check reserves its 16px on every row, visible or not. Put it
  // after the badge and it strands each badge short of the dropdown's right
  // edge — the column the badge-less sentinel row's own check defines. The
  // order has regressed twice, so pin it: nothing renders past the badge.
  it("leaves the scope badge as the option row's trailing element", async () => {
    const user = userEvent.setup();
    render(
      <AgentSelector
        mode="single"
        flat
        agents={[personalProxy, orgProxy]}
        value=""
        onValueChange={vi.fn()}
        placeholder="Select proxy"
      />,
    );

    await user.click(screen.getByRole("combobox"));

    const option = await screen.findByRole("option", { name: /Shared Proxy/ });
    const badge = within(option).getByLabelText("Organization");
    const lastRendered = [...option.querySelectorAll("*")].at(-1);

    expect(badge.contains(lastRendered ?? null)).toBe(true);
  });

  it("flat mode lists llm_proxy items that the grouped view would drop", async () => {
    const onValueChange = vi.fn();
    const user = userEvent.setup();
    render(
      <AgentSelector
        mode="single"
        flat
        agents={[personalProxy, orgProxy]}
        value=""
        onValueChange={onValueChange}
        placeholder="Select proxy"
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByText("Shared Proxy"));

    expect(onValueChange).toHaveBeenCalledWith("p2");
  });
});

describe("AgentSelector sentinelOption", () => {
  it("renders the sentinel label in the trigger when it is the current value", () => {
    render(
      <AgentSelector
        mode="single"
        flat
        agents={[personalProxy, orgProxy]}
        value="all"
        onValueChange={vi.fn()}
        sentinelOption={{ value: "all", label: "All Agents & LLM Proxies" }}
      />,
    );

    expect(
      within(screen.getByRole("combobox")).getByText(
        "All Agents & LLM Proxies",
      ),
    ).toBeInTheDocument();
  });

  it("selects the sentinel value rather than an agent id", async () => {
    const onValueChange = vi.fn();
    const user = userEvent.setup();
    render(
      <AgentSelector
        mode="single"
        flat
        agents={[personalProxy, orgProxy]}
        value="p1"
        onValueChange={onValueChange}
        sentinelOption={{ value: "all", label: "All Agents & LLM Proxies" }}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByText("All Agents & LLM Proxies"));

    expect(onValueChange).toHaveBeenCalledWith("all");
  });

  it("hides the sentinel while a search excludes its label", async () => {
    const user = userEvent.setup();
    render(
      <AgentSelector
        mode="single"
        flat
        agents={[personalProxy, orgProxy]}
        value="all"
        onValueChange={vi.fn()}
        sentinelOption={{ value: "all", label: "All Agents & LLM Proxies" }}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.type(screen.getByPlaceholderText("Search agents..."), "shared");

    expect(await screen.findByText("Shared Proxy")).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /All Agents & LLM Proxies/ }),
    ).not.toBeInTheDocument();
  });
});

describe("AgentSelector (multiple, flat)", () => {
  it("flat mode lists and toggles llm_proxy items that the grouped view would drop", async () => {
    const onValueChange = vi.fn();
    const user = userEvent.setup();
    render(
      <AgentSelector
        mode="multiple"
        flat
        agents={[personalProxy, orgProxy]}
        value={[]}
        onValueChange={onValueChange}
        placeholder="Select proxies"
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByText("Shared Proxy"));

    expect(onValueChange).toHaveBeenCalledWith(["p2"]);
  });

  it("renders selected agents as removable badges", () => {
    render(
      <AgentSelector
        mode="multiple"
        flat
        agents={[personalProxy, orgProxy]}
        value={["p2"]}
        onValueChange={vi.fn()}
      />,
    );

    expect(screen.getByText("Shared Proxy")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Remove Shared Proxy" }),
    ).toBeInTheDocument();
  });
});
