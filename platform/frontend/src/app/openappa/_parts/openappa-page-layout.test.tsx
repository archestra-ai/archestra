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
const setupState = vi.hoisted(() => ({
  isFresh: false as boolean | undefined,
}));
vi.mock("./use-openappa-setup-state", () => ({
  useOpenAppaSetupState: () => setupState,
}));

test.each([
  ["/openappa", "Overview"],
  ["/openappa/batteries", "Batteries"],
  ["/openappa/policy", "Policy"],
])("selects %s as the %s tab", (pathname, tabName) => {
  setupState.isFresh = false;
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
  const configureLink = screen.queryByRole("link", {
    name: "Configure with chat",
  });
  if (pathname === "/openappa/policy") {
    expect(configureLink).toHaveAttribute(
      "href",
      expect.stringMatching(
        /^\/chat\?openappa=1&openappaPrompt=explainPolicy&from=openappa$/,
      ),
    );
  } else {
    expect(configureLink).not.toBeInTheDocument();
  }
});

test("a fresh Overview hides the tabs until a policy is saved", () => {
  setupState.isFresh = true;
  vi.mocked(usePathname).mockReturnValue("/openappa");
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as ReturnType<typeof useSearchParams>,
  );

  render(
    <OpenAppaPageLayout>
      <div>Content</div>
    </OpenAppaPageLayout>,
  );

  expect(screen.getByText("Content")).toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: "Policy" }),
  ).not.toBeInTheDocument();
});
