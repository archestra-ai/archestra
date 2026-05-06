import { describe, expect, it, vi } from "@/test";
import {
  buildAzureDeploymentsUrl,
  buildAzureOpenAiV1ModelsUrl,
  buildAzureResponsesBaseUrl,
  createAzureFetchWithApiVersion,
  extractAzureDeploymentName,
  isAzureAiFoundryBaseUrl,
  isAzureOpenAiV1BaseUrl,
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

describe("buildAzureOpenAiV1ModelsUrl", () => {
  it("builds a models URL from a Foundry v1 base URL", () => {
    expect(
      buildAzureOpenAiV1ModelsUrl(
        "https://my-resource.services.ai.azure.com/openai/v1",
      ),
    ).toBe("https://my-resource.services.ai.azure.com/openai/v1/models");
  });

  it("returns null for deployment-scoped URLs", () => {
    expect(
      buildAzureOpenAiV1ModelsUrl(
        "https://my-resource.openai.azure.com/openai/deployments/gpt-4o",
      ),
    ).toBeNull();
  });

  it("returns null for invalid URLs", () => {
    expect(buildAzureOpenAiV1ModelsUrl("not-a-valid-url")).toBeNull();
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

describe("isAzureOpenAiV1BaseUrl", () => {
  it("returns true for Foundry v1 OpenAI endpoints", () => {
    expect(
      isAzureOpenAiV1BaseUrl(
        "https://my-resource.services.ai.azure.com/openai/v1",
      ),
    ).toBe(true);
  });

  it("returns false for deployment-scoped Azure OpenAI endpoints", () => {
    expect(
      isAzureOpenAiV1BaseUrl(
        "https://my-resource.openai.azure.com/openai/deployments/gpt-4o",
      ),
    ).toBe(false);
  });

  it("returns false for invalid URLs", () => {
    expect(isAzureOpenAiV1BaseUrl("not-a-valid-url")).toBe(false);
  });
});

describe("isAzureAiFoundryBaseUrl", () => {
  it("returns true for Azure AI Foundry resource hostnames", () => {
    expect(
      isAzureAiFoundryBaseUrl("https://my-resource.services.ai.azure.com"),
    ).toBe(true);
  });

  it("returns true for the Azure AI Foundry root hostname", () => {
    expect(isAzureAiFoundryBaseUrl("https://ai.azure.com")).toBe(true);
  });

  it("returns false for the public Anthropic API hostname", () => {
    expect(isAzureAiFoundryBaseUrl("https://api.anthropic.com")).toBe(false);
  });

  it("returns false for invalid URLs", () => {
    expect(isAzureAiFoundryBaseUrl("not-a-valid-url")).toBe(false);
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
