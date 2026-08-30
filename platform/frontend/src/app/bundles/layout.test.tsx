import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFeature } from "@/lib/config/config.query";
import BundlesLayout from "./layout";

vi.mock("@/lib/config/config.query");

vi.mock("@/components/page-layout", () => ({
  PageLayout: ({
    title,
    description,
    children,
  }: {
    title: React.ReactNode;
    description?: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <section>
      <h1>{title}</h1>
      <p>{description}</p>
      {children}
    </section>
  ),
}));

describe("BundlesLayout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the disabled deployment page without mounting bundle routes", () => {
    vi.mocked(useFeature).mockReturnValue(false);

    render(
      <BundlesLayout>
        <div>Bundle route content</div>
      </BundlesLayout>,
    );

    expect(screen.getByRole("heading", { name: "Bundles" })).toBeVisible();
    expect(
      screen.getByText("Bundles are disabled for this deployment."),
    ).toBeVisible();
    expect(screen.queryByText("Bundle route content")).not.toBeInTheDocument();
  });

  it("renders bundle routes after the beta is enabled", () => {
    vi.mocked(useFeature).mockReturnValue(true);

    render(
      <BundlesLayout>
        <div>Bundle route content</div>
      </BundlesLayout>,
    );

    expect(screen.getByText("Bundle route content")).toBeVisible();
  });
});
