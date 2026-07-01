import { render, screen } from "@testing-library/react";
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
