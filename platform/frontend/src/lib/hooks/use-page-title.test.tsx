import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/organization.query", () => ({
  useAppearanceSettings: () => ({
    data: { appName: "Example App" },
    isFetched: true,
  }),
}));

import { DynamicHead } from "@/components/dynamic-head";
import { PageTitleProvider, usePageTitle } from "./use-page-title";

function PageTitle({ title }: { title: string }) {
  usePageTitle(title);
  return null;
}

describe("usePageTitle", () => {
  afterEach(() => {
    document.title = "";
  });

  it("updates the tab when the page title changes and restores the app title on exit", async () => {
    const renderTitle = (title: string) => (
      <PageTitleProvider>
        <DynamicHead />
        <PageTitle title={title} />
      </PageTitleProvider>
    );
    const { rerender, unmount } = render(renderTitle("Chat"));

    await waitFor(() => expect(document.title).toBe("Chat - Example App"));

    rerender(renderTitle("Incident review"));
    await waitFor(() =>
      expect(document.title).toBe("Incident review - Example App"),
    );

    unmount();
  });
});
