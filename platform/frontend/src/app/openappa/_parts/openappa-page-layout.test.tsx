import { render, screen } from "@testing-library/react";
import { usePathname, useSearchParams } from "next/navigation";
import { expect, test, vi } from "vitest";
import { OpenAppaPageLayout } from "./openappa-page-layout";

vi.mock("next/navigation");
vi.mock("@/lib/hooks/use-app-name", () => ({
  useAppName: () => "Archestra",
}));
vi.mock("./batteries-panel", () => ({
  BatteriesUploadAction: () => null,
}));

test.each([
  ["/openappa", "Overview"],
  ["/openappa/batteries", "Batteries"],
  ["/openappa/policy", "Policy"],
])("selects %s as the %s tab", (pathname, tabName) => {
  vi.mocked(usePathname).mockReturnValue(pathname);
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as ReturnType<typeof useSearchParams>,
  );

  render(
    <OpenAppaPageLayout>
      <div>Content</div>
    </OpenAppaPageLayout>,
  );

  expect(screen.getAllByRole("link", { name: tabName })[0]).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("configuration chat replaces the tabs and links back to overview", () => {
  vi.mocked(usePathname).mockReturnValue("/openappa/configure");
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as ReturnType<typeof useSearchParams>,
  );
  render(<OpenAppaPageLayout>Chat</OpenAppaPageLayout>);
  expect(
    screen.queryByRole("link", { name: "Batteries" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute(
    "href",
    "/openappa",
  );
});
