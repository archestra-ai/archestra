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
  ["/openappa/chat", "Chat"],
  ["/openappa/conversation-123", "Chat"],
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
  if (tabName === "Chat") {
    expect(
      screen.getAllByRole("link", { name: "Overview" })[0],
    ).not.toHaveAttribute("aria-current");
  }
});
