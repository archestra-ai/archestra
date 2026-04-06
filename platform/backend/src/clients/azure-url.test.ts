import { describe, expect, it, vi } from "@/test";
import {
  buildAzureDeploymentsUrl,
  createAzureFetchWithApiVersion,
} from "./azure-url";

describe("buildAzureDeploymentsUrl", () => {
  it("builds a deployments URL from an Azure deployment base URL", () => {
    expect(
      buildAzureDeploymentsUrl({
        apiVersion: "2024-02-01",
        baseUrl:
          "https://my-resource.openai.azure.com/openai/deployments/gpt-4o",
      }),
    ).toBe(
      "https://my-resource.openai.azure.com/openai/deployments?api-version=2024-02-01",
    );
  });

  it("returns null for an invalid base URL", () => {
    expect(
      buildAzureDeploymentsUrl({
        apiVersion: "2024-02-01",
        baseUrl: "not-a-valid-url",
      }),
    ).toBeNull();
  });
});

describe("createAzureFetchWithApiVersion", () => {
  it("appends api-version to string URL input", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("{}"));
    const fetchWithVersion = createAzureFetchWithApiVersion({
      apiVersion: "2024-02-01",
      fetch: mockFetch,
    });

    await fetchWithVersion(
      "https://my-resource.openai.azure.com/openai/deployments/gpt-4o/chat/completions",
      {},
    );

    expect(mockFetch).toHaveBeenCalledWith(
      "https://my-resource.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-02-01",
      {},
    );
  });

  it("appends api-version to URL object input", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("{}"));
    const fetchWithVersion = createAzureFetchWithApiVersion({
      apiVersion: "2024-02-01",
      fetch: mockFetch,
    });

    await fetchWithVersion(
      new URL(
        "https://my-resource.openai.azure.com/openai/deployments/gpt-4o/chat/completions",
      ),
      {},
    );

    expect(mockFetch).toHaveBeenCalledWith(
      "https://my-resource.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-02-01",
      {},
    );
  });

  it("preserves existing query params on Request input", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("{}"));
    const fetchWithVersion = createAzureFetchWithApiVersion({
      apiVersion: "2024-02-01",
      fetch: mockFetch,
    });

    await fetchWithVersion(
      new Request(
        "https://my-resource.openai.azure.com/openai/deployments/gpt-4o/chat/completions?existing=value",
      ),
      {},
    );

    expect(mockFetch).toHaveBeenCalledWith(
      "https://my-resource.openai.azure.com/openai/deployments/gpt-4o/chat/completions?existing=value&api-version=2024-02-01",
      {},
    );
  });
});
