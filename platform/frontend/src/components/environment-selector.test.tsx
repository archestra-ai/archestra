import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useEnvironments } from "@/lib/environment.query";
import { useDefaultEnvironment } from "@/lib/organization.query";
import { EnvironmentSelector } from "./environment-selector";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/environment.query", () => ({ useEnvironments: vi.fn() }));

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

function setCanManageEnvironments(canManage: boolean) {
  vi.mocked(useHasPermissions).mockReturnValue({
    data: canManage,
  } as unknown as ReturnType<typeof useHasPermissions>);
}

describe("EnvironmentSelector — Manage environments link", () => {
  beforeEach(() => {
    vi.mocked(useEnvironments).mockReturnValue({
      data: { environments: [] },
    } as unknown as ReturnType<typeof useEnvironments>);
    vi.mocked(useDefaultEnvironment).mockReturnValue({
      name: "Default",
      description: "",
    } as unknown as ReturnType<typeof useDefaultEnvironment>);
  });

  test("omits the Manage environments link when the user lacks environment:update", () => {
    setCanManageEnvironments(false);
    render(
      <EnvironmentSelector value={null} onChange={vi.fn()} resource="agent" />,
    );

    expect(
      screen.getByText(/Only the default environment is available/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /manage environments/i }),
    ).not.toBeInTheDocument();
  });

  test("renders the Manage environments link when the user has environment:update", () => {
    setCanManageEnvironments(true);
    render(
      <EnvironmentSelector value={null} onChange={vi.fn()} resource="agent" />,
    );

    expect(
      screen.getByRole("link", { name: /manage environments/i }),
    ).toHaveAttribute("href", "/settings/environments");
  });
});

describe("EnvironmentSelector — saved value", () => {
  beforeEach(() => {
    vi.mocked(useDefaultEnvironment).mockReturnValue({
      name: "Default",
      description: "",
    } as unknown as ReturnType<typeof useDefaultEnvironment>);
  });

  test("keeps a saved restricted environment visible while allowing a move to default", async () => {
    setCanManageEnvironments(false);
    const onChange = vi.fn();
    vi.mocked(useEnvironments).mockReturnValue({
      data: {
        environments: [
          {
            id: "env-restricted",
            name: "Restricted Environment",
            description: "",
            restricted: true,
          },
        ],
      },
    } as unknown as ReturnType<typeof useEnvironments>);
    render(
      <EnvironmentSelector
        value="env-restricted"
        onChange={onChange}
        resource="agent"
      />,
    );

    const trigger = screen.getByRole("combobox", { name: "Environment" });
    expect(trigger).toHaveTextContent("Restricted Environment");
    expect(trigger).toBeEnabled();

    const user = userEvent.setup();
    await user.click(trigger);
    expect(
      screen.queryByRole("option", { name: "Restricted Environment" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Default" }));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
