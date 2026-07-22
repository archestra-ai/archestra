import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useEnvironments } from "@/lib/environment.query";
import { useDefaultEnvironment } from "@/lib/organization.query";
import { EnvironmentSelector } from "./environment-selector";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/environment.query", () => ({ useEnvironments: vi.fn() }));

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
