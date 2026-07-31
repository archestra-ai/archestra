import { vi } from "vitest";
import { describe, expect, test } from "@/test";

vi.mock("@kubernetes/client-node", () => {
  class MockKubeConfig {
    clusters = [{ name: "test", server: "https://test" }];
    contexts = [{ name: "test" }];
    users = [{ name: "test" }];
    loadFromDefault() {}
    loadFromCluster() {}
    loadFromFile() {}
    loadFromString() {}
    makeApiClient() {
      return {};
    }
  }
  return {
    KubeConfig: MockKubeConfig,
    CoreV1Api: vi.fn(),
    AppsV1Api: vi.fn(),
    BatchV1Api: vi.fn(),
    AuthorizationV1Api: vi.fn(),
    NetworkingV1Api: vi.fn(),
    CustomObjectsApi: vi.fn(),
    Attach: vi.fn(),
    Log: vi.fn(),
  };
});

vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    orchestrator: {
      kubernetes: {
        namespace: "",
        kubeconfig: undefined,
        loadKubeconfigFromCurrentCluster: false,
      },
    },
  }),
);

describe("shared K8s utilities", () => {
  describe("sanitizeLabelValue", () => {
    async function getSanitizeLabelValue() {
      const { sanitizeLabelValue } = await import("./shared");
      return sanitizeLabelValue;
    }

    test.each([
      // Basic sanitization
      ["My Server", "my-server"],
      ["TEST-VALUE", "test-value"],

      // Special characters removed
      ["value@123", "value123"],
      ["hello_world", "helloworld"],

      // Truncation to 63 characters
      ["a".repeat(100), "a".repeat(63)],

      // Trailing non-alphanumeric removal
      ["value-", "value"],
      ["value.", "value"],
      ["value--", "value"],

      // UUID-like values
      [
        "123e4567-e89b-12d3-a456-426614174000",
        "123e4567-e89b-12d3-a456-426614174000",
      ],

      // Emojis and unicode
      ["Server 🔥", "server"],
      ["Servér", "servr"],

      // Empty string
      ["", ""],

      // Whitespace
      ["hello world foo", "hello-world-foo"],

      // Leading non-alphanumeric
      ["-value", "value"],
      ["--value", "value"],
      [".value", "value"],

      // Consecutive hyphens collapsed
      ["a--b", "a-b"],
      ["a---b", "a-b"],

      // Consecutive dots collapsed
      ["a..b", "a.b"],

      // Mixed special characters
      ["@#$%^&*()", ""],
    ])("sanitizes '%s' to '%s'", async (input, expected) => {
      const sanitizeLabelValue = await getSanitizeLabelValue();
      const result = sanitizeLabelValue(input);
      expect(result).toBe(expected);

      // Verify result is valid K8s label value
      expect(result.length).toBeLessThanOrEqual(63);
      if (result.length > 0) {
        expect(result).toMatch(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/);
      }
    });
  });

  describe("isK8sNotFoundError", () => {
    async function getIsK8sNotFoundError() {
      const { isK8sNotFoundError } = await import("./shared");
      return isK8sNotFoundError;
    }

    test("returns true for error with statusCode 404", async () => {
      const isK8sNotFoundError = await getIsK8sNotFoundError();
      expect(isK8sNotFoundError({ statusCode: 404 })).toBe(true);
    });

    test("returns true for error with code 404", async () => {
      const isK8sNotFoundError = await getIsK8sNotFoundError();
      expect(isK8sNotFoundError({ code: 404 })).toBe(true);
    });

    test("returns true for error with response.statusCode 404", async () => {
      const isK8sNotFoundError = await getIsK8sNotFoundError();
      expect(isK8sNotFoundError({ response: { statusCode: 404 } })).toBe(true);
    });

    test("returns false for non-404 statusCode", async () => {
      const isK8sNotFoundError = await getIsK8sNotFoundError();
      expect(isK8sNotFoundError({ statusCode: 500 })).toBe(false);
    });

    test("returns false for non-404 code", async () => {
      const isK8sNotFoundError = await getIsK8sNotFoundError();
      expect(isK8sNotFoundError({ code: 403 })).toBe(false);
    });

    test("returns false for null", async () => {
      const isK8sNotFoundError = await getIsK8sNotFoundError();
      expect(isK8sNotFoundError(null)).toBe(false);
    });

    test("returns false for undefined", async () => {
      const isK8sNotFoundError = await getIsK8sNotFoundError();
      expect(isK8sNotFoundError(undefined)).toBe(false);
    });

    test("returns false for string errors", async () => {
      const isK8sNotFoundError = await getIsK8sNotFoundError();
      expect(isK8sNotFoundError("not found")).toBe(false);
    });

    test("returns false for Error instances without statusCode", async () => {
      const isK8sNotFoundError = await getIsK8sNotFoundError();
      expect(isK8sNotFoundError(new Error("K8s API error"))).toBe(false);
    });

    test("returns false for empty object", async () => {
      const isK8sNotFoundError = await getIsK8sNotFoundError();
      expect(isK8sNotFoundError({})).toBe(false);
    });
  });

  describe("isK8sConflictError", () => {
    async function getIsK8sConflictError() {
      const { isK8sConflictError } = await import("./shared");
      return isK8sConflictError;
    }

    test("returns true for statusCode, code, and response.statusCode 409", async () => {
      const isK8sConflictError = await getIsK8sConflictError();
      expect(isK8sConflictError({ statusCode: 409 })).toBe(true);
      expect(isK8sConflictError({ code: 409 })).toBe(true);
      expect(isK8sConflictError({ response: { statusCode: 409 } })).toBe(true);
    });

    test("returns false for non-409 errors and nullish input", async () => {
      const isK8sConflictError = await getIsK8sConflictError();
      expect(isK8sConflictError({ statusCode: 404 })).toBe(false);
      expect(isK8sConflictError({ response: { statusCode: 500 } })).toBe(false);
      expect(isK8sConflictError(null)).toBe(false);
      expect(isK8sConflictError(undefined)).toBe(false);
    });
  });

  describe("isK8sConfigured", () => {
    test("returns false when no K8s env vars are set", async () => {
      vi.resetModules();
      vi.doMock("@/config", async (importOriginal) => {
        const actual = await importOriginal<typeof import("@/config")>();
        return {
          default: {
            ...actual.default,
            orchestrator: {
              kubernetes: {
                namespace: "",
                kubeconfig: undefined,
                loadKubeconfigFromCurrentCluster: false,
              },
            },
          },
        };
      });
      const { isK8sConfigured } = await import("./shared");
      expect(isK8sConfigured()).toBe(false);
    });

    test("returns true when kubeconfig is set", async () => {
      vi.resetModules();
      vi.doMock("@/config", async (importOriginal) => {
        const actual = await importOriginal<typeof import("@/config")>();
        return {
          default: {
            ...actual.default,
            orchestrator: {
              kubernetes: {
                namespace: "",
                kubeconfig: "/path/to/kubeconfig",
                loadKubeconfigFromCurrentCluster: false,
              },
            },
          },
        };
      });
      const { isK8sConfigured } = await import("./shared");
      expect(isK8sConfigured()).toBe(true);
    });

    test("returns true when loadKubeconfigFromCurrentCluster is true", async () => {
      vi.resetModules();
      vi.doMock("@/config", async (importOriginal) => {
        const actual = await importOriginal<typeof import("@/config")>();
        return {
          default: {
            ...actual.default,
            orchestrator: {
              kubernetes: {
                namespace: "",
                kubeconfig: undefined,
                loadKubeconfigFromCurrentCluster: true,
              },
            },
          },
        };
      });
      const { isK8sConfigured } = await import("./shared");
      expect(isK8sConfigured()).toBe(true);
    });

    test("returns false when kubeconfig is empty string", async () => {
      vi.resetModules();
      vi.doMock("@/config", async (importOriginal) => {
        const actual = await importOriginal<typeof import("@/config")>();
        return {
          default: {
            ...actual.default,
            orchestrator: {
              kubernetes: {
                namespace: "",
                kubeconfig: "  ",
                loadKubeconfigFromCurrentCluster: false,
              },
            },
          },
        };
      });
      const { isK8sConfigured } = await import("./shared");
      expect(isK8sConfigured()).toBe(false);
    });
  });

  describe("getK8sNamespace", () => {
    test("returns configured namespace when set", async () => {
      vi.resetModules();
      vi.doMock("@/config", async (importOriginal) => {
        const actual = await importOriginal<typeof import("@/config")>();
        return {
          default: {
            ...actual.default,
            orchestrator: {
              kubernetes: {
                namespace: "custom-namespace",
                kubeconfig: undefined,
                loadKubeconfigFromCurrentCluster: false,
              },
            },
          },
        };
      });
      const { getK8sNamespace } = await import("./shared");
      expect(getK8sNamespace()).toBe("custom-namespace");
    });

    test("returns 'default' when namespace is not set", async () => {
      vi.resetModules();
      vi.doMock("@/config", async (importOriginal) => {
        const actual = await importOriginal<typeof import("@/config")>();
        return {
          default: {
            ...actual.default,
            orchestrator: {
              kubernetes: {
                namespace: "",
                kubeconfig: undefined,
                loadKubeconfigFromCurrentCluster: false,
              },
            },
          },
        };
      });
      const { getK8sNamespace } = await import("./shared");
      expect(getK8sNamespace()).toBe("default");
    });
  });

  describe("validateKubeconfig", () => {
    test("returns early for undefined path", async () => {
      const { validateKubeconfig } = await import("./shared");
      expect(() => validateKubeconfig(undefined)).not.toThrow();
    });

    test("throws for non-existent file", async () => {
      const { validateKubeconfig } = await import("./shared");
      expect(() => validateKubeconfig("/nonexistent/path")).toThrow(
        "Kubeconfig file not found",
      );
    });
  });

  describe("ensureStringIsRfc1123Compliant", () => {
    async function getEnsureStringIsRfc1123Compliant() {
      const { ensureStringIsRfc1123Compliant } = await import("./shared");
      return ensureStringIsRfc1123Compliant;
    }

    test.each([
      ["My Server", "my-server"],
      ["TEST-VALUE", "test-value"],
      ["hello_world", "helloworld"],
      ["a..b", "a.b"],
      ["a--b", "a-b"],
      ["-leading", "leading"],
      ["trailing-", "trailing"],
      ["UPPER CASE", "upper-case"],
    ])("converts '%s' to '%s'", async (input, expected) => {
      const fn = await getEnsureStringIsRfc1123Compliant();
      expect(fn(input)).toBe(expected);
    });
  });

  describe("sanitizeMetadataLabels", () => {
    test("sanitizes both keys and values", async () => {
      const { sanitizeMetadataLabels } = await import("./shared");
      const result = sanitizeMetadataLabels({
        "My Key": "My Value",
        ANOTHER_KEY: "another_value",
      });
      expect(result).toEqual({
        "my-key": "my-value",
        anotherkey: "anothervalue",
      });
    });

    test("truncates values to 63 characters", async () => {
      const { sanitizeMetadataLabels } = await import("./shared");
      const result = sanitizeMetadataLabels({
        key: "a".repeat(100),
      });
      expect(result.key.length).toBeLessThanOrEqual(63);
    });
  });

  describe("checkNamespaceDeployAccess", () => {
    test("returns ok and checks the namespaced create-deployments permission", async () => {
      const { checkNamespaceDeployAccess } = await import("./shared");
      const createReview = vi
        .fn()
        .mockResolvedValue({ status: { allowed: true } });
      const authApi = { createSelfSubjectAccessReview: createReview };

      const result = await checkNamespaceDeployAccess(
        "prod-ns",
        authApi as unknown as Parameters<typeof checkNamespaceDeployAccess>[1],
      );

      expect(result).toEqual({ ok: true });
      // It must probe create-deployments in the namespace — NOT read the
      // namespace object (which would need cluster-scoped `get namespaces`).
      expect(createReview).toHaveBeenCalledWith({
        body: {
          spec: {
            resourceAttributes: {
              namespace: "prod-ns",
              verb: "create",
              group: "apps",
              resource: "deployments",
            },
          },
        },
      });
    });

    test("returns forbidden when the review denies access", async () => {
      const { checkNamespaceDeployAccess } = await import("./shared");
      const authApi = {
        createSelfSubjectAccessReview: vi
          .fn()
          .mockResolvedValue({ status: { allowed: false } }),
      };

      const result = await checkNamespaceDeployAccess(
        "prod-ns",
        authApi as unknown as Parameters<typeof checkNamespaceDeployAccess>[1],
      );

      expect(result).toEqual({ ok: false, reason: "forbidden" });
    });

    test("returns unavailable when the review call throws", async () => {
      const { checkNamespaceDeployAccess } = await import("./shared");
      const authApi = {
        createSelfSubjectAccessReview: vi
          .fn()
          .mockRejectedValue(new Error("network down")),
      };

      const result = await checkNamespaceDeployAccess(
        "prod-ns",
        authApi as unknown as Parameters<typeof checkNamespaceDeployAccess>[1],
      );

      expect(result).toEqual({ ok: false, reason: "unavailable" });
    });
  });

  describe("namespaceAccessMessage", () => {
    test("forbidden message names the namespace and points at the Helm value", async () => {
      const { namespaceAccessMessage } = await import("./shared");
      const msg = namespaceAccessMessage("prod-ns", "forbidden");
      expect(msg).toContain("prod-ns");
      expect(msg).toContain("environmentNamespaces");
    });

    test("unavailable message is generic", async () => {
      const { namespaceAccessMessage } = await import("./shared");
      expect(namespaceAccessMessage("prod-ns", "unavailable")).toBe(
        "Could not reach the Kubernetes cluster.",
      );
    });
  });
});

describe("isTransientK8sApiError", () => {
  test("throttling and API-server unavailability are transient", async () => {
    const { isTransientK8sApiError } = await import("./shared");
    expect(isTransientK8sApiError({ code: 429 })).toBe(true);
    expect(isTransientK8sApiError({ statusCode: 429 })).toBe(true);
    expect(isTransientK8sApiError({ response: { statusCode: 503 } })).toBe(
      true,
    );
    expect(isTransientK8sApiError({ code: 500 })).toBe(true);
    expect(isTransientK8sApiError({ code: 502 })).toBe(true);
    expect(isTransientK8sApiError({ code: 504 })).toBe(true);
  });

  test("caller errors and unknown shapes are not transient", async () => {
    const { isTransientK8sApiError } = await import("./shared");
    expect(isTransientK8sApiError({ code: 404 })).toBe(false);
    expect(isTransientK8sApiError({ code: 403 })).toBe(false);
    expect(isTransientK8sApiError({ code: 409 })).toBe(false);
    expect(isTransientK8sApiError(new Error("boom"))).toBe(false);
    expect(isTransientK8sApiError(undefined)).toBe(false);
    expect(isTransientK8sApiError("429")).toBe(false);
  });
});

describe("withK8sApiRetry", () => {
  test("retries a 429 honoring retry-after and returns the eventual result", async () => {
    const { withK8sApiRetry } = await import("./shared");
    const throttled = {
      code: 429,
      message: "Too many requests, please try again later.",
      headers: { "retry-after": "0.001" },
    };
    const fn = vi
      .fn()
      .mockRejectedValueOnce(throttled)
      .mockRejectedValueOnce(throttled)
      .mockResolvedValue("ok");

    await expect(withK8sApiRetry(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test("throws the last error once attempts are exhausted", async () => {
    const { withK8sApiRetry } = await import("./shared");
    const throttled = {
      code: 429,
      message: "Too many requests, please try again later.",
      headers: { "retry-after": "0.001" },
    };
    const fn = vi.fn().mockRejectedValue(throttled);

    await expect(withK8sApiRetry(fn, { attempts: 2 })).rejects.toEqual(
      throttled,
    );
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("does not retry non-transient errors", async () => {
    const { withK8sApiRetry } = await import("./shared");
    const notFound = { code: 404, message: "not found" };
    const fn = vi.fn().mockRejectedValue(notFound);

    await expect(withK8sApiRetry(fn)).rejects.toEqual(notFound);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("mapWithConcurrency", () => {
  test("preserves item order and captures per-item rejections", async () => {
    const { mapWithConcurrency } = await import("./shared");
    const results = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("nope");
      return n * 10;
    });

    expect(results).toEqual([
      { status: "fulfilled", value: 10 },
      { status: "rejected", reason: new Error("nope") },
      { status: "fulfilled", value: 30 },
    ]);
  });

  test("never runs more than `limit` items at once", async () => {
    const { mapWithConcurrency } = await import("./shared");
    let inFlight = 0;
    let maxInFlight = 0;

    await mapWithConcurrency(
      Array.from({ length: 10 }, (_, i) => i),
      3,
      () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<void>((resolve) =>
          setTimeout(() => {
            inFlight--;
            resolve();
          }, 5),
        );
      },
    );

    expect(maxInFlight).toBe(3);
  });
});
