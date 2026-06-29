import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: ReactNode }) => (
    <a {...props}>{children}</a>
  ),
}));

vi.mock("@/lib/environment.query", () => ({ useEnvironments: vi.fn() }));
vi.mock("@/lib/organization.query", () => ({ useDefaultEnvironment: vi.fn() }));

import { useEnvironments } from "@/lib/environment.query";
import { useDefaultEnvironment } from "@/lib/organization.query";
import { McpAppMetaBar } from "./mcp-app-meta-bar";

const mockUseEnvironments = vi.mocked(useEnvironments);
const mockUseDefaultEnvironment = vi.mocked(useDefaultEnvironment);

type App = Parameters<typeof McpAppMetaBar>[0]["app"];

function makeApp(overrides: Partial<App>): App {
  return {
    id: "app-1",
    name: "Hello World",
    scope: "personal",
    teams: [],
    authorId: "user-1",
    environmentId: null,
    ...overrides,
  } as App;
}

function setEnvironments(environments: Array<{ id: string; name: string }>) {
  mockUseEnvironments.mockReturnValue({ data: { environments } } as ReturnType<
    typeof useEnvironments
  >);
}

describe("McpAppMetaBar", () => {
  it("shows the version, visibility, and an Edit MCP server link to the beta registry", () => {
    setEnvironments([]);
    mockUseDefaultEnvironment.mockReturnValue({ name: "Default" } as ReturnType<
      typeof useDefaultEnvironment
    >);

    render(<McpAppMetaBar app={makeApp({ scope: "org" })} version={4} />);

    expect(screen.getByText("v4")).toBeInTheDocument();
    expect(screen.getByText("Organization")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /manage mcp server/i }),
    ).toHaveAttribute("href", "/mcp/registry/beta?search=Hello%20World");
  });

  it("lists the team names for team-scoped apps", () => {
    setEnvironments([]);
    mockUseDefaultEnvironment.mockReturnValue({ name: "Default" } as ReturnType<
      typeof useDefaultEnvironment
    >);

    render(
      <McpAppMetaBar
        app={makeApp({
          scope: "team",
          teams: [{ id: "t1", name: "Platform" }],
        })}
        version={1}
      />,
    );

    expect(screen.getByText("Platform")).toBeInTheDocument();
  });

  it("shows the environment label when the app runs on a named environment", () => {
    setEnvironments([{ id: "env-1", name: "Production" }]);
    mockUseDefaultEnvironment.mockReturnValue({ name: "Default" } as ReturnType<
      typeof useDefaultEnvironment
    >);

    render(
      <McpAppMetaBar app={makeApp({ environmentId: "env-1" })} version={2} />,
    );

    expect(screen.getByText("Production")).toBeInTheDocument();
  });
});
