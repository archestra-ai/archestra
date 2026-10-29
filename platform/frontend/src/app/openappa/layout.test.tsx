import { render, screen } from "@testing-library/react";
import { notFound, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useConfig } from "@/lib/config/config.query";
import { makeConfig } from "@/mocks/data/config";
import OpenAppaLayout from "./layout";

vi.mock("next/navigation");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("./_parts/openappa-page-layout", () => ({
  OpenAppaPageLayout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="openappa-layout">{children}</div>
  ),
}));
vi.mock("./_parts/openappa-licence-required", () => ({
  OpenAppaLicenceRequired: ({
    tier,
  }: {
    tier: { threshold: number; userCount: number };
  }) => (
    <div data-testid="licence-required">
      {tier.userCount}/{tier.threshold}
    </div>
  ),
}));

type ConfigQuery = ReturnType<typeof useConfig>;

function configQuery(query: Partial<ConfigQuery>) {
  vi.mocked(useConfig).mockReturnValue({
    data: undefined,
    isPending: false,
    isLoadingError: false,
    error: null,
    refetch: vi.fn(),
    ...query,
  } as ConfigQuery);
}

function renderLayout() {
  return render(
    <OpenAppaLayout>
      <p>Guardrails page</p>
    </OpenAppaLayout>,
  );
}

describe("OpenAppaLayout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
    );
  });

  it("opens the product from the cached config when OpenAPPA is licensed", () => {
    const config = makeConfig();
    config.features.openappaEnabled = true;
    configQuery({ data: config });

    renderLayout();

    expect(screen.getByText("Guardrails page")).toBeVisible();
    expect(screen.queryByTestId("licence-required")).toBeNull();
  });

  it("shows the licence page with the instance's own user count", () => {
    const config = makeConfig();
    config.features.openappaEnabled = false;
    config.smallTeamTier = {
      ...config.smallTeamTier,
      threshold: 30,
      userCount: 42,
    };
    configQuery({ data: config });

    renderLayout();

    expect(screen.getByTestId("licence-required")).toHaveTextContent("42/30");
    expect(screen.queryByText("Guardrails page")).toBeNull();
  });

  it("shows neither page until the config is known", () => {
    configQuery({ isPending: true });

    const { container } = renderLayout();

    expect(container).toBeEmptyDOMElement();
  });

  it("offers a retry when the config cannot be loaded", () => {
    const refetch = vi.fn();
    configQuery({ isLoadingError: true, error: new Error("offline"), refetch });

    renderLayout();

    expect(screen.getByText("Couldn't load Guardrails")).toBeVisible();
    screen.getByRole("button", { name: "Retry" }).click();
    expect(refetch).toHaveBeenCalled();
    expect(screen.queryByText("Guardrails page")).toBeNull();
  });

  it("treats a missing config as a missing page", () => {
    vi.mocked(notFound).mockImplementation(() => {
      throw new Error("NEXT_NOT_FOUND");
    });
    configQuery({ data: null });

    expect(() => renderLayout()).toThrow("NEXT_NOT_FOUND");
  });
});
