import { vi } from "vitest";
import type * as originalConfigModule from "@/config";
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
    Attach: vi.fn(),
    Log: vi.fn(),
  };
});

vi.mock("@/config", async (importOriginal) => {
  const actual = await importOriginal<typeof originalConfigModule>();
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

  describe("isK8sConfigured", () => {
    test("returns false when no K8s env vars are set", async () => {
      vi.resetModules();
      vi.doMock("@/config", async (importOriginal) => {
        const actual = await importOriginal<typeof originalConfigModule>();
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
        const actual = await importOriginal<typeof originalConfigModule>();
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
        const actual = await importOriginal<typeof originalConfigModule>();
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
        const actual = await importOriginal<typeof originalConfigModule>();
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
        const actual = await importOriginal<typeof originalConfigModule>();
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
        const actual = await importOriginal<typeof originalConfigModule>();
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

  describe("buildKubeConfig", () => {
    function setupKcMock() {
      vi.doMock("@kubernetes/client-node", () => {
        class MockKubeConfig {
          clusters = [{ name: "test", server: "https://test" }];
          contexts = [{ name: "test" }];
          users = [{ name: "test" }];
          loadFromCluster = vi.fn();
          loadFromFile = vi.fn();
          loadFromDefault = vi.fn();
          loadFromString = vi.fn((content: string) => {
            if (content === "__INVALID_YAML__") {
              throw new Error("malformed YAML");
            }
          });
          makeApiClient() {
            return {};
          }
        }
        return {
          KubeConfig: MockKubeConfig,
          CoreV1Api: vi.fn(),
          AppsV1Api: vi.fn(),
          BatchV1Api: vi.fn(),
          Attach: vi.fn(),
          Log: vi.fn(),
          Exec: vi.fn(),
        };
      });
    }

    test("calls kc.loadFromCluster() when loadFromCluster=true", async () => {
      vi.resetModules();
      setupKcMock();
      const { buildKubeConfig } = await import("./shared");
      const { kubeConfig } = buildKubeConfig({ loadFromCluster: true });
      const kc = kubeConfig as unknown as {
        loadFromCluster: ReturnType<typeof vi.fn>;
        loadFromString: ReturnType<typeof vi.fn>;
        loadFromFile: ReturnType<typeof vi.fn>;
        loadFromDefault: ReturnType<typeof vi.fn>;
      };
      expect(kc.loadFromCluster).toHaveBeenCalledTimes(1);
      expect(kc.loadFromString).not.toHaveBeenCalled();
      expect(kc.loadFromFile).not.toHaveBeenCalled();
      expect(kc.loadFromDefault).not.toHaveBeenCalled();
    });

    test("calls kc.loadFromString(yaml) when kubeconfigYaml is non-empty", async () => {
      vi.resetModules();
      setupKcMock();
      const { buildKubeConfig } = await import("./shared");
      const yaml = "apiVersion: v1\nkind: Config";
      const { kubeConfig } = buildKubeConfig({ kubeconfigYaml: yaml });
      const kc = kubeConfig as unknown as {
        loadFromCluster: ReturnType<typeof vi.fn>;
        loadFromString: ReturnType<typeof vi.fn>;
        loadFromFile: ReturnType<typeof vi.fn>;
        loadFromDefault: ReturnType<typeof vi.fn>;
      };
      expect(kc.loadFromString).toHaveBeenCalledTimes(1);
      expect(kc.loadFromString).toHaveBeenCalledWith(yaml);
      expect(kc.loadFromCluster).not.toHaveBeenCalled();
      expect(kc.loadFromFile).not.toHaveBeenCalled();
      expect(kc.loadFromDefault).not.toHaveBeenCalled();
    });

    test("throws a descriptive error when kubeconfigYaml is invalid", async () => {
      vi.resetModules();
      setupKcMock();
      const { buildKubeConfig } = await import("./shared");
      expect(() =>
        buildKubeConfig({ kubeconfigYaml: "__INVALID_YAML__" }),
      ).toThrow(/kubeconfig/i);
    });

    test("treats empty kubeconfigYaml as not provided and falls through to default", async () => {
      vi.resetModules();
      setupKcMock();
      const { buildKubeConfig } = await import("./shared");
      const { kubeConfig } = buildKubeConfig({ kubeconfigYaml: "" });
      const kc = kubeConfig as unknown as {
        loadFromCluster: ReturnType<typeof vi.fn>;
        loadFromString: ReturnType<typeof vi.fn>;
        loadFromFile: ReturnType<typeof vi.fn>;
        loadFromDefault: ReturnType<typeof vi.fn>;
      };
      expect(kc.loadFromString).not.toHaveBeenCalled();
      expect(kc.loadFromDefault).toHaveBeenCalledTimes(1);
    });

    test("calls kc.loadFromFile(path) when kubeconfigPath is non-empty", async () => {
      vi.resetModules();
      setupKcMock();
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "shared-test-kubeconfig-"),
      );
      const tmpFile = path.join(tmpDir, "kubeconfig.yaml");
      fs.writeFileSync(
        tmpFile,
        [
          "apiVersion: v1",
          "kind: Config",
          "clusters:",
          "  - name: test",
          "    cluster:",
          "      server: https://test",
          "contexts:",
          "  - name: test",
          "    context:",
          "      cluster: test",
          "      user: test",
          "users:",
          "  - name: test",
          "    user: {}",
          "",
        ].join("\n"),
      );
      try {
        const { buildKubeConfig } = await import("./shared");
        const { kubeConfig } = buildKubeConfig({ kubeconfigPath: tmpFile });
        const kc = kubeConfig as unknown as {
          loadFromCluster: ReturnType<typeof vi.fn>;
          loadFromString: ReturnType<typeof vi.fn>;
          loadFromFile: ReturnType<typeof vi.fn>;
          loadFromDefault: ReturnType<typeof vi.fn>;
        };
        expect(kc.loadFromFile).toHaveBeenCalledTimes(1);
        expect(kc.loadFromFile).toHaveBeenCalledWith(tmpFile);
        expect(kc.loadFromCluster).not.toHaveBeenCalled();
        expect(kc.loadFromDefault).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("throws when kubeconfigPath does not exist (validateKubeconfig)", async () => {
      vi.resetModules();
      setupKcMock();
      const { buildKubeConfig } = await import("./shared");
      expect(() =>
        buildKubeConfig({ kubeconfigPath: "/nonexistent/kubeconfig" }),
      ).toThrow(/Kubeconfig file not found/);
    });

    test("calls kc.loadFromDefault() when no source is provided", async () => {
      vi.resetModules();
      setupKcMock();
      const { buildKubeConfig } = await import("./shared");
      const { kubeConfig } = buildKubeConfig({});
      const kc = kubeConfig as unknown as {
        loadFromCluster: ReturnType<typeof vi.fn>;
        loadFromString: ReturnType<typeof vi.fn>;
        loadFromFile: ReturnType<typeof vi.fn>;
        loadFromDefault: ReturnType<typeof vi.fn>;
      };
      expect(kc.loadFromDefault).toHaveBeenCalledTimes(1);
      expect(kc.loadFromCluster).not.toHaveBeenCalled();
      expect(kc.loadFromString).not.toHaveBeenCalled();
      expect(kc.loadFromFile).not.toHaveBeenCalled();
    });

    test("loadFromCluster=true wins over kubeconfigYaml and kubeconfigPath", async () => {
      vi.resetModules();
      setupKcMock();
      const { buildKubeConfig } = await import("./shared");
      const { kubeConfig } = buildKubeConfig({
        loadFromCluster: true,
        kubeconfigYaml: "apiVersion: v1",
        kubeconfigPath: "/some/path",
      });
      const kc = kubeConfig as unknown as {
        loadFromCluster: ReturnType<typeof vi.fn>;
        loadFromString: ReturnType<typeof vi.fn>;
        loadFromFile: ReturnType<typeof vi.fn>;
        loadFromDefault: ReturnType<typeof vi.fn>;
      };
      expect(kc.loadFromCluster).toHaveBeenCalledTimes(1);
      expect(kc.loadFromString).not.toHaveBeenCalled();
      expect(kc.loadFromFile).not.toHaveBeenCalled();
      expect(kc.loadFromDefault).not.toHaveBeenCalled();
    });

    test("kubeconfigYaml wins over kubeconfigPath", async () => {
      vi.resetModules();
      setupKcMock();
      const { buildKubeConfig } = await import("./shared");
      const yaml = "apiVersion: v1\nkind: Config";
      const { kubeConfig } = buildKubeConfig({
        kubeconfigYaml: yaml,
        kubeconfigPath: "/some/path",
      });
      const kc = kubeConfig as unknown as {
        loadFromCluster: ReturnType<typeof vi.fn>;
        loadFromString: ReturnType<typeof vi.fn>;
        loadFromFile: ReturnType<typeof vi.fn>;
        loadFromDefault: ReturnType<typeof vi.fn>;
      };
      expect(kc.loadFromString).toHaveBeenCalledTimes(1);
      expect(kc.loadFromString).toHaveBeenCalledWith(yaml);
      expect(kc.loadFromFile).not.toHaveBeenCalled();
      expect(kc.loadFromCluster).not.toHaveBeenCalled();
      expect(kc.loadFromDefault).not.toHaveBeenCalled();
    });

    test("returns the explicit namespace when provided", async () => {
      vi.resetModules();
      setupKcMock();
      const { buildKubeConfig } = await import("./shared");
      const { namespace } = buildKubeConfig({
        loadFromCluster: true,
        namespace: "personal",
      });
      expect(namespace).toBe("personal");
    });

    test("falls back namespace to 'default' when input.namespace is empty", async () => {
      vi.resetModules();
      setupKcMock();
      const { buildKubeConfig } = await import("./shared");
      const { namespace } = buildKubeConfig({
        loadFromCluster: true,
        namespace: "",
      });
      expect(namespace).toBe("default");
    });

    test("falls back namespace to 'default' when input.namespace is undefined", async () => {
      vi.resetModules();
      setupKcMock();
      const { buildKubeConfig } = await import("./shared");
      const { namespace } = buildKubeConfig({});
      expect(namespace).toBe("default");
    });
  });

  describe("loadKubeConfig (env-var wrapper around buildKubeConfig)", () => {
    function setupKcMock() {
      vi.doMock("@kubernetes/client-node", () => {
        class MockKubeConfig {
          clusters = [{ name: "test", server: "https://test" }];
          contexts = [{ name: "test" }];
          users = [{ name: "test" }];
          loadFromCluster = vi.fn();
          loadFromFile = vi.fn();
          loadFromDefault = vi.fn();
          loadFromString = vi.fn();
          makeApiClient() {
            return {};
          }
        }
        return {
          KubeConfig: MockKubeConfig,
          CoreV1Api: vi.fn(),
          AppsV1Api: vi.fn(),
          BatchV1Api: vi.fn(),
          Attach: vi.fn(),
          Log: vi.fn(),
          Exec: vi.fn(),
        };
      });
    }

    test("uses loadFromCluster when ARCHESTRA_ORCHESTRATOR_LOAD_KUBECONFIG_FROM_CURRENT_CLUSTER is true", async () => {
      vi.resetModules();
      setupKcMock();
      vi.doMock("@/config", async (importOriginal) => {
        const actual = await importOriginal<typeof originalConfigModule>();
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
      const { loadKubeConfig } = await import("./shared");
      const { kubeConfig, namespace } = loadKubeConfig();
      const kc = kubeConfig as unknown as {
        loadFromCluster: ReturnType<typeof vi.fn>;
        loadFromDefault: ReturnType<typeof vi.fn>;
      };
      expect(kc.loadFromCluster).toHaveBeenCalledTimes(1);
      expect(kc.loadFromDefault).not.toHaveBeenCalled();
      expect(namespace).toBe("default");
    });

    test("uses loadFromDefault when no env vars are set", async () => {
      vi.resetModules();
      setupKcMock();
      vi.doMock("@/config", async (importOriginal) => {
        const actual = await importOriginal<typeof originalConfigModule>();
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
      const { loadKubeConfig } = await import("./shared");
      const { kubeConfig, namespace } = loadKubeConfig();
      const kc = kubeConfig as unknown as {
        loadFromCluster: ReturnType<typeof vi.fn>;
        loadFromFile: ReturnType<typeof vi.fn>;
        loadFromDefault: ReturnType<typeof vi.fn>;
      };
      expect(kc.loadFromDefault).toHaveBeenCalledTimes(1);
      expect(kc.loadFromCluster).not.toHaveBeenCalled();
      expect(kc.loadFromFile).not.toHaveBeenCalled();
      expect(namespace).toBe("default");
    });

    test("returns configured namespace when ARCHESTRA_ORCHESTRATOR_K8S_NAMESPACE is set", async () => {
      vi.resetModules();
      setupKcMock();
      vi.doMock("@/config", async (importOriginal) => {
        const actual = await importOriginal<typeof originalConfigModule>();
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
      const { loadKubeConfig } = await import("./shared");
      const { namespace } = loadKubeConfig();
      expect(namespace).toBe("custom-namespace");
    });

    test("uses loadFromFile with kubeconfig path from env when set", async () => {
      vi.resetModules();
      setupKcMock();
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "shared-test-loadkc-"),
      );
      const tmpFile = path.join(tmpDir, "kubeconfig.yaml");
      fs.writeFileSync(
        tmpFile,
        [
          "apiVersion: v1",
          "kind: Config",
          "clusters:",
          "  - name: test",
          "    cluster:",
          "      server: https://test",
          "contexts:",
          "  - name: test",
          "    context:",
          "      cluster: test",
          "      user: test",
          "users:",
          "  - name: test",
          "    user: {}",
          "",
        ].join("\n"),
      );
      vi.doMock("@/config", async (importOriginal) => {
        const actual = await importOriginal<typeof originalConfigModule>();
        return {
          default: {
            ...actual.default,
            orchestrator: {
              kubernetes: {
                namespace: "",
                kubeconfig: tmpFile,
                loadKubeconfigFromCurrentCluster: false,
              },
            },
          },
        };
      });
      try {
        const { loadKubeConfig } = await import("./shared");
        const { kubeConfig } = loadKubeConfig();
        const kc = kubeConfig as unknown as {
          loadFromFile: ReturnType<typeof vi.fn>;
          loadFromDefault: ReturnType<typeof vi.fn>;
          loadFromCluster: ReturnType<typeof vi.fn>;
        };
        expect(kc.loadFromFile).toHaveBeenCalledTimes(1);
        expect(kc.loadFromFile).toHaveBeenCalledWith(tmpFile);
        expect(kc.loadFromDefault).not.toHaveBeenCalled();
        expect(kc.loadFromCluster).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
