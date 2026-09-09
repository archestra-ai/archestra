import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DynamicHead } from "@/components/dynamic-head";
import { PageTitleProvider, usePageTitle } from "./use-page-title";

const server = setupServer(
  http.get("http://localhost:9000/api/organization/appearance-settings", () =>
    HttpResponse.json({ appName: "Example App" }),
  ),
);

beforeAll(() => {
  archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  cleanup();
  document.title = "";
});

afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

describe("usePageTitle", () => {
  it("updates the tab when the page title changes and restores the app title on exit", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const renderTitle = (title: string | null) => (
      <QueryClientProvider client={client}>
        <PageTitleProvider>
          <DynamicHead />
          {title !== null && <PageTitle title={title} />}
        </PageTitleProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(renderTitle("Chat"));

    await waitFor(() => expect(document.title).toBe("Chat - Example App"));

    rerender(renderTitle("Incident review"));
    await waitFor(() =>
      expect(document.title).toBe("Incident review - Example App"),
    );

    rerender(renderTitle(null));
    await waitFor(() => expect(document.title).toBe("Example App"));
  });
});

function PageTitle({ title }: { title: string }) {
  usePageTitle(title);
  return null;
}
