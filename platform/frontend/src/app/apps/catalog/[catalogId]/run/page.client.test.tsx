import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CatalogAppRunPage from "./page.client";

const resolution = {
  catalogId: "cat-1",
  name: "Archestra PM",
  description: null,
  resourceUri: "ui://pm/backlog.html",
  resources: [
    {
      resourceUri: "ui://pm/backlog.html",
      toolName: "show_backlog",
      name: "Archestra PM / show_backlog",
    },
    {
      resourceUri: "ui://pm/board.html",
      toolName: "show_board",
      name: "Archestra PM / show_board",
    },
  ],
  defaultMcpServerId: "srv-1",
  installs: [
    { mcpServerId: "srv-1", scope: "org" as const, name: "Org install" },
  ],
};

let searchString = "";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: ReactNode }) => (
    <a {...props}>{children}</a>
  ),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(searchString),
}));

vi.mock("@/lib/app.query", () => ({
  useExternalApp: () => ({ data: resolution, isPending: false }),
}));

vi.mock("@/components/mcp-app/app-frame", () => ({
  AppFrame: ({ resourceUri }: { resourceUri: string }) => (
    <div data-testid="app-frame" data-resource={resourceUri} />
  ),
}));

afterEach(() => {
  searchString = "";
});

describe("CatalogAppRunPage", () => {
  it("renders the resource named by ?resource= and labels the header", () => {
    searchString = "resource=ui://pm/board.html";
    render(<CatalogAppRunPage catalogId="cat-1" />);

    expect(screen.getByTestId("app-frame")).toHaveAttribute(
      "data-resource",
      "ui://pm/board.html",
    );
    expect(screen.getByText("Archestra PM / show_board")).toBeInTheDocument();
  });

  it("falls back to the default resource when ?resource= is absent or unknown", () => {
    searchString = "resource=ui://pm/does-not-exist.html";
    render(<CatalogAppRunPage catalogId="cat-1" />);

    expect(screen.getByTestId("app-frame")).toHaveAttribute(
      "data-resource",
      "ui://pm/backlog.html",
    );
  });
});
