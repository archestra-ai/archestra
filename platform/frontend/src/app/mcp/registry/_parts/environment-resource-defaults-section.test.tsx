import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  useEnvironments,
  useUpdateEnvironmentResourceDefaults,
} from "@/lib/environment.query";
import { useDefaultEnvironment } from "@/lib/organization.query";
import { EnvironmentResourceDefaultsSection } from "./environment-resource-defaults-section";

// Radix Select relies on pointer-capture / scrollIntoView, which jsdom omits.
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();

vi.mock("@/lib/organization.query");
vi.mock("@/lib/environment.query", () => ({
  useEnvironments: vi.fn(),
  useUpdateEnvironmentResourceDefaults: vi.fn(),
}));

const mutate = vi.fn();

function setEnvironments(
  environments: { id: string; name: string; restricted: boolean }[],
  resourceDefaults: Record<string, string | null> = {},
) {
  vi.mocked(useEnvironments).mockReturnValue({
    data: {
      environments,
      defaultAssignedCatalogCount: 0,
      resourceDefaults: {
        mcpRegistry: null,
        app: null,
        agent: null,
        mcpGateway: null,
        llmProxy: null,
        knowledgeSource: null,
        ...resourceDefaults,
      },
    },
  } as unknown as ReturnType<typeof useEnvironments>);
}

describe("EnvironmentResourceDefaultsSection", () => {
  beforeEach(() => {
    mutate.mockClear();
    vi.mocked(useUpdateEnvironmentResourceDefaults).mockReturnValue({
      mutate,
      isPending: false,
    } as unknown as ReturnType<typeof useUpdateEnvironmentResourceDefaults>);
    vi.mocked(useDefaultEnvironment).mockReturnValue({
      name: "Default",
    } as unknown as ReturnType<typeof useDefaultEnvironment>);
  });

  test("renders nothing when the org has no environments to choose from", () => {
    setEnvironments([]);
    const { container } = render(
      <EnvironmentResourceDefaultsSection canEdit />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  test("shows the configured environment per resource kind", () => {
    setEnvironments(
      [
        { id: "env-explore", name: "Explore", restricted: false },
        { id: "env-launch", name: "Launch", restricted: false },
      ],
      { mcpRegistry: "env-explore", app: "env-launch" },
    );
    render(<EnvironmentResourceDefaultsSection canEdit />);

    expect(screen.getByLabelText("MCP servers")).toHaveTextContent("Explore");
    expect(screen.getByLabelText("MCP Apps")).toHaveTextContent("Launch");
    // Unconfigured kinds keep landing in the org Default environment.
    expect(screen.getByLabelText("Agents")).toHaveTextContent("Default");
  });

  test("saves only the kind that changed", async () => {
    setEnvironments([{ id: "env-launch", name: "Launch", restricted: false }]);
    render(<EnvironmentResourceDefaultsSection canEdit />);

    await userEvent.click(screen.getByLabelText("MCP Apps"));
    await userEvent.click(screen.getByRole("option", { name: "Launch" }));

    expect(mutate).toHaveBeenCalledWith({ app: "env-launch" });
  });

  test("warns that a restricted target falls back for creators without permission", () => {
    setEnvironments(
      [{ id: "env-locked", name: "Locked", restricted: true }],
      { mcpRegistry: "env-locked" },
    );
    render(<EnvironmentResourceDefaultsSection canEdit />);

    expect(
      screen.getByText(/Creators without permission to deploy here fall back/i),
    ).toBeInTheDocument();
  });

  test("is read-only without environment:update", () => {
    setEnvironments([{ id: "env-launch", name: "Launch", restricted: false }]);
    render(<EnvironmentResourceDefaultsSection canEdit={false} />);

    expect(screen.getByLabelText("MCP Apps")).toBeDisabled();
  });
});
