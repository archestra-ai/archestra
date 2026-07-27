import { describe, expect, it, vi } from "@/test";
import {
  buildAzureDeploymentBaseUrl,
  buildAzureDeploymentsUrl,
  buildAzureModelsUrl,
  buildAzureOpenAiV1ModelsUrl,
  buildAzureResponsesBaseUrl,
  buildAzureV1DeploymentsUrl,
  createAzureFetchWithApiVersion,
  extractAzureDeploymentName,
  isAzureAiFoundryBaseUrl,
  isAzureOpenAiFirstPartyModelName,
  isAzureOpenAiV1BaseUrl,
  isAzureThinkingModelName,
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
    ).toBeNull();
  });

  it("handles a root path URL", () => {
    expect(
      buildAzureDeploymentsUrl({
        apiVersion: "2024-02-01",
        baseUrl: "https://my-resource.openai.azure.com",
      }),
    ).toBeNull();
  });

  it("builds a deployments URL from a resource-level OpenAI base URL", () => {
    expect(
      buildAzureDeploymentsUrl({
        apiVersion: "2024-02-01",
        baseUrl: "https://my-resource.openai.azure.com/openai",
      }),
    ).toBe(
      "https://my-resource.openai.azure.com/openai/deployments?api-version=2024-02-01",
    );
  });

  it("preserves an explicit deployments collection base URL", () => {
    expect(
      buildAzureDeploymentsUrl({
        apiVersion: "2024-02-01",
        baseUrl: "https://my-resource.openai.azure.com/openai/deployments",
      }),
    ).toBe(
      "https://my-resource.openai.azure.com/openai/deployments?api-version=2024-02-01",
    );
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

describe("buildAzureV1DeploymentsUrl", () => {
  it("derives the classic deployments URL from a v1 base URL", () => {
    // /openai/v1/models returns the regional catalog, so the deployments a
    // resource actually serves have to come from the classic data plane —
    // and only on an api-version that still exposes it (2024-02-01 404s).
    expect(
      buildAzureV1DeploymentsUrl(
        "https://my-resource.openai.azure.com/openai/v1",
      ),
    ).toBe(
      "https://my-resource.openai.azure.com/openai/deployments?api-version=2023-03-15-preview",
    );
  });

  it("tolerates a trailing slash", () => {
    expect(
      buildAzureV1DeploymentsUrl(
        "https://my-resource.services.ai.azure.com/openai/v1/",
      ),
    ).toBe(
      "https://my-resource.services.ai.azure.com/openai/deployments?api-version=2023-03-15-preview",
    );
  });

  it("returns null for non-v1 base URLs", () => {
    expect(
      buildAzureV1DeploymentsUrl(
        "https://my-resource.openai.azure.com/openai/deployments/gpt-4o",
      ),
    ).toBeNull();
    expect(buildAzureV1DeploymentsUrl("not-a-valid-url")).toBeNull();
  });
});

describe("buildAzureModelsUrl", () => {
  it("builds a models URL from a resource-level Azure OpenAI base URL", () => {
    expect(
      buildAzureModelsUrl({
        apiVersion: "2024-02-01",
        baseUrl: "https://my-resource.openai.azure.com/openai",
      }),
    ).toBe(
      "https://my-resource.openai.azure.com/openai/models?api-version=2024-02-01",
    );
  });

  it("builds a models URL from a deployment-scoped Azure OpenAI base URL", () => {
    expect(
      buildAzureModelsUrl({
        apiVersion: "2024-02-01",
        baseUrl:
          "https://my-resource.openai.azure.com/openai/deployments/gpt-4o",
      }),
    ).toBe(
      "https://my-resource.openai.azure.com/openai/models?api-version=2024-02-01",
    );
  });

  it("returns null for Foundry v1 base URLs", () => {
    expect(
      buildAzureModelsUrl({
        apiVersion: "2024-02-01",
        baseUrl: "https://my-resource.services.ai.azure.com/openai/v1",
      }),
    ).toBeNull();
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

  it("accepts a resource-level OpenAI base URL", () => {
    expect(
      buildAzureResponsesBaseUrl("https://my-resource.openai.azure.com/openai"),
    ).toBe("https://my-resource.openai.azure.com/openai");
  });

  it("accepts a deployments collection base URL", () => {
    expect(
      buildAzureResponsesBaseUrl(
        "https://my-resource.openai.azure.com/openai/deployments",
      ),
    ).toBe("https://my-resource.openai.azure.com/openai");
  });
});

describe("buildAzureDeploymentBaseUrl", () => {
  it("appends the deployment to a resource-level OpenAI base URL", () => {
    expect(
      buildAzureDeploymentBaseUrl({
        baseUrl: "https://my-resource.openai.azure.com/openai",
        deploymentName: "gpt-4o",
      }),
    ).toBe("https://my-resource.openai.azure.com/openai/deployments/gpt-4o");
  });

  it("preserves deployment-scoped base URLs for compatibility", () => {
    expect(
      buildAzureDeploymentBaseUrl({
        baseUrl:
          "https://my-resource.openai.azure.com/openai/deployments/gpt-4o",
        deploymentName: "gpt-4o-mini",
      }),
    ).toBe("https://my-resource.openai.azure.com/openai/deployments/gpt-4o");
  });

  it("preserves Azure OpenAI v1 base URLs", () => {
    expect(
      buildAzureDeploymentBaseUrl({
        baseUrl: "https://my-resource.services.ai.azure.com/openai/v1",
        deploymentName: "gpt-4o",
      }),
    ).toBe("https://my-resource.services.ai.azure.com/openai/v1");
  });

  it("returns null for invalid base URLs", () => {
    expect(
      buildAzureDeploymentBaseUrl({
        baseUrl: "not-a-url",
        deploymentName: "gpt-4o",
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

  it("returns null for a resource-level Azure OpenAI base URL", () => {
    expect(
      extractAzureDeploymentName("https://my-resource.openai.azure.com/openai"),
    ).toBeNull();
  });
});

describe("isAzureThinkingModelName", () => {
  it.each([
    "DeepSeek-R1",
    "DeepSeek-V4-Pro",
    "deepseek-v3.2",
    "MAI-DS-R1",
  ])("returns true for the verified thinking family %s", (name) => {
    expect(isAzureThinkingModelName(name)).toBe(true);
  });

  it.each([
    "gpt-4o",
    "claude-opus-5",
    "Phi-4-reasoning",
    "Llama-3.3-70B",
  ])("returns false for %s, which is not known to accept reasoning_effort", (name) => {
    expect(isAzureThinkingModelName(name)).toBe(false);
  });
});

describe("isAzureOpenAiFirstPartyModelName", () => {
  it.each([
    "gpt-5.5",
    "gpt-5.5-pro",
    "gpt-5-chat",
    "gpt-4o",
    "gpt-4.1-mini",
    "gpt-35-turbo",
    "o1-preview",
    "o3-mini",
    "o4-mini",
    "chatgpt-4o-latest",
    "codex-mini",
    "GPT-4o",
  ])("returns true for OpenAI first-party deployment name %s", (name) => {
    expect(isAzureOpenAiFirstPartyModelName(name)).toBe(true);
  });

  it.each([
    "DeepSeek-R1",
    "DeepSeek-R1-0528",
    "grok-4",
    "Phi-4-reasoning",
    "Llama-3.3-70B-Instruct",
    "mistral-large",
  ])("returns false for Foundry open-model deployment name %s", (name) => {
    expect(isAzureOpenAiFirstPartyModelName(name)).toBe(false);
  });

  it("returns false for gpt-oss despite the gpt- prefix", () => {
    expect(isAzureOpenAiFirstPartyModelName("gpt-oss-120b")).toBe(false);
    expect(isAzureOpenAiFirstPartyModelName("GPT-OSS-20b")).toBe(false);
  });
});
