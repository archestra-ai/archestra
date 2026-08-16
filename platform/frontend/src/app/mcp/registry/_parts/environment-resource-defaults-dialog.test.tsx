import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  useEnvironments,
  useUpdateEnvironmentResourceDefaults,
} from "@/lib/environment.query";
import { useDefaultEnvironment } from "@/lib/organization.query";
import { EnvironmentResourceDefaultsDialog } from "./environment-resource-defaults-dialog";

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

function renderDialog(
  props: { canEdit: boolean; open?: boolean } = {
    canEdit: true,
  },
) {
  return render(
    <EnvironmentResourceDefaultsDialog
      open={props.open ?? true}
      onOpenChange={vi.fn()}
      canEdit={props.canEdit}
    />,
  );
}

describe("EnvironmentResourceDefaultsDialog", () => {
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

  test("shows the configured environment per resource kind", () => {
    setEnvironments(
      [
        { id: "env-explore", name: "Explore", restricted: false },
        { id: "env-launch", name: "Launch", restricted: false },
      ],
      { mcpRegistry: "env-explore", app: "env-launch" },
    );
    renderDialog();

    expect(screen.getByLabelText("MCP servers")).toHaveTextContent("Explore");
    expect(screen.getByLabelText("MCP Apps")).toHaveTextContent("Launch");
    // Unconfigured kinds keep landing in the org Default environment.
    expect(screen.getByLabelText("Agents")).toHaveTextContent("Default");
  });

  test("saves only the kind that changed", async () => {
    setEnvironments([{ id: "env-launch", name: "Launch", restricted: false }]);
    renderDialog();

    await userEvent.click(screen.getByLabelText("MCP Apps"));
    await userEvent.click(screen.getByRole("option", { name: "Launch" }));

    expect(mutate).toHaveBeenCalledWith({ app: "env-launch" });
  });

  test("warns that a restricted target falls back for creators without permission", () => {
    setEnvironments([{ id: "env-locked", name: "Locked", restricted: true }], {
      mcpRegistry: "env-locked",
    });
    renderDialog();

    expect(
      screen.getByText(/Creators without permission to deploy here fall back/i),
    ).toBeInTheDocument();
  });

  test("is read-only without environment:update", () => {
    setEnvironments([{ id: "env-launch", name: "Launch", restricted: false }]);
    renderDialog({ canEdit: false });

    expect(screen.getByLabelText("MCP Apps")).toBeDisabled();
  });

  test("renders nothing while closed", () => {
    setEnvironments([{ id: "env-launch", name: "Launch", restricted: false }]);
    renderDialog({ canEdit: true, open: false });

    expect(screen.queryByLabelText("MCP Apps")).not.toBeInTheDocument();
  });
});
