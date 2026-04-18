import { describe, expect, it, vi } from "@/test";
import {
  buildAzureDeploymentsUrl,
  buildAzureResponsesBaseUrl,
  createAzureFetchWithApiVersion,
  extractAzureDeploymentName,
  normalizeAzureApiKey,
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

  it("handles a single-segment path", () => {
    expect(
      buildAzureDeploymentsUrl({
        apiVersion: "2024-02-01",
        baseUrl: "https://my-resource.openai.azure.com/gpt-4o",
      }),
    ).toBe("https://my-resource.openai.azure.com?api-version=2024-02-01");
  });

  it("handles a root path URL", () => {
    expect(
      buildAzureDeploymentsUrl({
        apiVersion: "2024-02-01",
        baseUrl: "https://my-resource.openai.azure.com",
      }),
    ).toBe("https://my-resource.openai.azure.com/?api-version=2024-02-01");
  });

  it("handles paths with trailing slashes", () => {
    expect(
      buildAzureDeploymentsUrl({
        apiVersion: "2024-02-01",
        baseUrl:
          "https://my-resource.openai.azure.com/openai/deployments/gpt-4o/",
      }),
    ).toBe(
      "https://my-resource.openai.azure.com/openai/deployments?api-version=2024-02-01",
    );
  });
});

describe("buildAzureResponsesBaseUrl", () => {
  it("strips the deployment segment from the configured base URL", () => {
    expect(
      buildAzureResponsesBaseUrl(
        "https://my-resource.openai.azure.com/openai/deployments/gpt-5.2-chat",
      ),
    ).toBe("https://my-resource.openai.azure.com/openai");
  });

  it("strips a trailing slash after the deployment segment", () => {
    expect(
      buildAzureResponsesBaseUrl(
        "https://my-resource.openai.azure.com/openai/deployments/gpt-5.2-chat/",
      ),
    ).toBe("https://my-resource.openai.azure.com/openai");
  });

  it("returns null for an invalid URL", () => {
    expect(buildAzureResponsesBaseUrl("not-a-url")).toBeNull();
  });

  it("returns null when the base URL is not deployment-scoped", () => {
    expect(
      buildAzureResponsesBaseUrl("https://my-resource.openai.azure.com/openai"),
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

describe("normalizeAzureApiKey", () => {
  it("strips a Bearer prefix", () => {
    expect(normalizeAzureApiKey("Bearer my-azure-key")).toBe("my-azure-key");
  });

  it("strips a bearer prefix case-insensitively", () => {
    expect(normalizeAzureApiKey("bearer my-azure-key")).toBe("my-azure-key");
  });

  it("returns the original key when no Bearer prefix is present", () => {
    expect(normalizeAzureApiKey("my-azure-key")).toBe("my-azure-key");
  });

  it("returns undefined when the key is undefined", () => {
    expect(normalizeAzureApiKey(undefined)).toBeUndefined();
  });
});

describe("extractAzureDeploymentName", () => {
  it("extracts the deployment name from an Azure deployment base URL", () => {
    expect(
      extractAzureDeploymentName(
        "https://my-resource.openai.azure.com/openai/deployments/gpt-5.2-chat",
      ),
    ).toBe("gpt-5.2-chat");
  });

  it("extracts the deployment name from a trailing-slash deployment URL", () => {
    expect(
      extractAzureDeploymentName(
        "https://my-resource.openai.azure.com/openai/deployments/gpt-5.2-chat/",
      ),
    ).toBe("gpt-5.2-chat");
  });

  it("returns null for an invalid URL", () => {
    expect(extractAzureDeploymentName("not-a-valid-url")).toBeNull();
  });
});
