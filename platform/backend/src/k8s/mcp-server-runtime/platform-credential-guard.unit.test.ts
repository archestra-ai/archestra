import type * as k8s from "@kubernetes/client-node";
import { describe, expect, test } from "vitest";
import {
  findPlatformCredentialReferences,
  findPlatformCredentialReferencesInYaml,
  platformCredentialsFromPodSpec,
} from "./platform-credential-guard";

const PLATFORM_POD_SPEC: k8s.V1PodSpec = {
  serviceAccountName: "archestra-platform",
  containers: [
    {
      name: "archestra-platform",
      env: [
        {
          name: "ARCHESTRA_AUTH_SECRET",
          valueFrom: {
            secretKeyRef: { name: "archestra-platform-auth", key: "auth" },
          },
        },
        {
          name: "ARCHESTRA_SHARED_KEY",
          valueFrom: { secretKeyRef: { name: "shared-keys", key: "key" } },
        },
      ],
      envFrom: [{ secretRef: { name: "platform-env" } }],
    },
  ],
  volumes: [
    { name: "files", persistentVolumeClaim: { claimName: "platform-files" } },
    {
      name: "bundle",
      projected: { sources: [{ secret: { name: "platform-tls" } }] },
    },
  ],
};

const PLATFORM = platformCredentialsFromPodSpec(PLATFORM_POD_SPEC, {
  allowedSecrets: ["shared-keys"],
});

describe("platformCredentialsFromPodSpec", () => {
  test("collects every credential the platform pod reads, minus allowed Secrets", () => {
    expect([...PLATFORM.serviceAccounts].sort()).toEqual([
      "archestra-platform",
      "archestra-platform-migrate",
    ]);
    expect([...PLATFORM.secrets].sort()).toEqual([
      "archestra-platform-auth",
      "platform-env",
      "platform-tls",
    ]);
    expect([...PLATFORM.persistentVolumeClaims]).toEqual(["platform-files"]);
  });

  test("does not deny the namespace default service account", () => {
    const platform = platformCredentialsFromPodSpec(
      { containers: [{ name: "app" }] },
      { allowedSecrets: [] },
    );
    expect(platform.serviceAccounts.size).toBe(0);
  });
});

describe("findPlatformCredentialReferences", () => {
  test.each([
    {
      reference: "a secret volume",
      podSpec: {
        volumes: [{ name: "x", secret: { secretName: "platform-env" } }],
      },
    },
    {
      reference: "a projected Secret",
      podSpec: {
        volumes: [
          {
            name: "x",
            projected: {
              sources: [{ secret: { name: "archestra-platform-auth" } }],
            },
          },
        ],
      },
    },
    {
      reference: "an env secretKeyRef in an init container",
      podSpec: {
        initContainers: [
          {
            name: "init",
            env: [
              {
                name: "KEY",
                valueFrom: {
                  secretKeyRef: { name: "archestra-platform-auth", key: "k" },
                },
              },
            ],
          },
        ],
      },
    },
    {
      reference: "a container envFrom",
      podSpec: {
        containers: [
          { name: "mcp", envFrom: [{ secretRef: { name: "platform-tls" } }] },
        ],
      },
    },
    {
      reference: "a platform volume claim",
      podSpec: {
        volumes: [
          {
            name: "x",
            persistentVolumeClaim: { claimName: "platform-files" },
          },
        ],
      },
    },
  ])("rejects $reference", ({ podSpec }) => {
    expect(
      findPlatformCredentialReferences({ podSpec, platform: PLATFORM }),
    ).toHaveLength(1);
  });

  test("rejects the platform service account and the registry envFrom setting", () => {
    const errors = findPlatformCredentialReferences({
      podSpec: undefined,
      serviceAccountName: " archestra-platform ",
      envFrom: [
        { type: "secret", name: "platform-env" },
        { type: "configMap", name: "platform-env" },
      ],
      platform: PLATFORM,
    });
    expect(errors).toEqual([
      expect.stringContaining('Service account "archestra-platform"'),
      expect.stringContaining('Secret "platform-env"'),
    ]);
  });

  test("allows Secrets the server owns or an operator manages", () => {
    const podSpec = {
      containers: [
        {
          name: "mcp",
          env: [
            {
              name: "OWN",
              valueFrom: {
                secretKeyRef: { name: "mcp-server-abc-secrets", key: "k" },
              },
            },
            {
              name: "PLACEHOLDER",
              valueFrom: {
                secretKeyRef: { name: `\${archestra.secret_name}`, key: "k" },
              },
            },
            {
              name: "SHARED",
              valueFrom: { secretKeyRef: { name: "shared-keys", key: "k" } },
            },
          ],
          envFrom: [{ secretRef: { name: "external-secret" } }],
        },
      ],
      volumes: [
        { name: "cache", persistentVolumeClaim: { claimName: "mcp-cache" } },
      ],
    };
    expect(
      findPlatformCredentialReferences({
        podSpec,
        serviceAccountName: "archestra-platform-mcp-k8s-operator",
        ownSecretName: "mcp-server-abc-secrets",
        platform: PLATFORM,
      }),
    ).toEqual([]);
  });

  test("rejects another server's Archestra-managed Secret even when the platform pod is unknown", () => {
    const errors = findPlatformCredentialReferences({
      podSpec: {
        volumes: [
          {
            name: "x",
            secret: { secretName: "mcp-server-mt-1234abcd-secrets" },
          },
        ],
      },
      ownSecretName: "mcp-server-abc-secrets",
      platform: null,
    });
    expect(errors).toEqual([
      expect.stringContaining("manages for another MCP server"),
    ]);
  });
});

describe("findPlatformCredentialReferencesInYaml", () => {
  test("checks the pod template of a custom deployment YAML", () => {
    const yaml = `apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: mcp-server
          image: example.invalid/mcp:1
          envFrom:
            - secretRef:
                name: platform-env
`;
    expect(
      findPlatformCredentialReferencesInYaml({ yaml, platform: PLATFORM }),
    ).toEqual([
      expect.stringContaining(
        'spec.template.spec.containers[0].envFrom[0].secretRef references Secret "platform-env"',
      ),
    ]);
  });

  test("leaves unparseable YAML to the structural validator", () => {
    expect(
      findPlatformCredentialReferencesInYaml({
        yaml: "spec: [",
        platform: PLATFORM,
      }),
    ).toEqual([]);
  });
});
