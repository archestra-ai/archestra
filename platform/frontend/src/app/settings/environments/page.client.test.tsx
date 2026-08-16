import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useEnvironments } from "@/lib/environment.query";
import EnvironmentsPageClient from "./page.client";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/environment.query", () => ({ useEnvironments: vi.fn() }));

// The section under the action button is exercised by its own tests; here we
// only care about what the page registers as the page-level action.
vi.mock("../../mcp/registry/_parts/environments-section", () => ({
  EnvironmentsSection: () => null,
}));

// The layout renders whatever the page registers, so render it inline to
// assert on the real buttons rather than on the registration call.
const setActionButton = vi.fn();
vi.mock("../layout", () => ({
  useSetSettingsAction: () => setActionButton,
}));

const replace = vi.fn();

function setEnvironmentCount(count: number) {
  vi.mocked(useEnvironments).mockReturnValue({
    data: {
      environments: Array.from({ length: count }, (_, index) => ({
        id: `env-${index}`,
      })),
      defaultAssignedCatalogCount: 0,
      resourceDefaults: {},
    },
  } as unknown as ReturnType<typeof useEnvironments>);
}

/** Renders the page, then the action node it registered with the layout. */
async function renderPageAction() {
  render(<EnvironmentsPageClient />);
  const action = setActionButton.mock.calls
    .map(([node]) => node as ReactNode)
    .filter(Boolean)
    .at(-1);
  render(<>{action}</>);
}

describe("EnvironmentsPageClient action buttons", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { useRouter, useSearchParams, usePathname } = await import(
      "next/navigation"
    );
    vi.mocked(useRouter).mockReturnValue({
      replace,
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(usePathname).mockReturnValue("/settings/environments");
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
    );
    const { useHasPermissions } = await import("@/lib/auth/auth.query");
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
    } as unknown as ReturnType<typeof useHasPermissions>);
  });

  test("hides the settings cog until the org has an environment to choose", async () => {
    setEnvironmentCount(0);
    await renderPageAction();

    expect(
      screen.getByRole("button", { name: /add environment/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /where new resources land/i }),
    ).not.toBeInTheDocument();
  });

  test("shows the settings cog once an environment exists", async () => {
    setEnvironmentCount(1);
    await renderPageAction();

    expect(
      screen.getByRole("button", { name: /where new resources land/i }),
    ).toBeInTheDocument();
  });

  test("the cog opens the settings dialog via the URL", async () => {
    setEnvironmentCount(2);
    await renderPageAction();

    await userEvent.click(
      screen.getByRole("button", { name: /where new resources land/i }),
    );

    expect(replace).toHaveBeenCalledWith(
      "/settings/environments?resource-defaults=1",
      { scroll: false },
    );
  });
});
