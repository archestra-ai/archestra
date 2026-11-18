import { generateKeyPairSync } from "node:crypto";
import * as yaml from "js-yaml";
import { describe, expect, test } from "vitest";
import {
  EnvironmentKubeconfigError,
  parseEnvironmentKubeconfig,
} from "./environment-kubeconfig";

// Self-signed certificates made for these tests. Certificates are public
// data; the private key a test needs is generated when it runs.
const CA_PEM = `-----BEGIN CERTIFICATE-----
MIIDGTCCAgGgAwIBAgIUCpmbshu06/DG5A8TiXsLNf3na5cwDQYJKoZIhvcNAQEL
BQAwHDEaMBgGA1UEAwwRYXJjaGVzdHJhLXRlc3QtY2EwHhcNMjYxMTE2MDAxOTA4
WhcNMzYxMTEzMDAxOTA4WjAcMRowGAYDVQQDDBFhcmNoZXN0cmEtdGVzdC1jYTCC
ASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAOBcK2PRPM7lam0IYiwDu0OW
ejWayhyLmNtQ2QEopkN8usI815JvUCk2jE4SIBJepGX0mEy2fV1D8SeEqBCqjhE5
qDUe+IW7xL8jOw0fQFqUfdx/XBOBmGkFpGBg+x2jU2d1INY3hJPSJknnuXrcFqDd
QF+4kOwqmSIgmUEMxHTlnXgHUxict3L0nup59XEku56y/dRgN199+GOgv9GAcuu2
7aAJ+saygx3FputmArw/ii6gFcODfuku2KJZuIKX/OviR4523Ad5YYPAWi1csJvM
LQlV29xYLTI3QZ35MCQbpUdlv1rWN1u5yW9UIeTeJl0U0pJ3PWsFSSQcZScnO38C
AwEAAaNTMFEwHQYDVR0OBBYEFLGMhJl1i5eVpvB1LPcxsIFqCZmWMB8GA1UdIwQY
MBaAFLGMhJl1i5eVpvB1LPcxsIFqCZmWMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZI
hvcNAQELBQADggEBAMgLM7N1I2o1NXFVbSNsYdtLZtmGM+LS2Y5sJNIA+chG2FNq
It7/PpZ6qylyd5qKFcG4oyoVZHV8obPAjAUsPjg8ZrXBkBE/zhGSE9kYpJasZT7+
Ms782Zv/dl/9OxVGuF2GUMni4ZIvVPR4sIaZQ03flnYGaYGphnc6oEnV8VBC51f0
CIXgwIhe63Z7bIwe4GsvgIvJqxw7WEVlKR9nR0kaIFDMHXCE6BUmqX7cdtcQGe4y
gEPaIXunfIQYWTuMBMcCCyvuZ01yhnZKzA1Y//z5uJWSglm21/9Mu9iYIqWG0b3r
tji/NhKnMYlUmDXWvyjHS56n6ETY7mAsdEFFmxg=
-----END CERTIFICATE-----
`;
const CLIENT_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDITCCAgmgAwIBAgIUO1nFxkdcsoTYemnqv1sBVEMR/s0wDQYJKoZIhvcNAQEL
BQAwIDEeMBwGA1UEAwwVYXJjaGVzdHJhLXRlc3QtY2xpZW50MB4XDTI2MTExNjAw
MTkwOFoXDTM2MTExMzAwMTkwOFowIDEeMBwGA1UEAwwVYXJjaGVzdHJhLXRlc3Qt
Y2xpZW50MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAi7CSGmyUOVmT
Qxyc9qgTwMvBc0KbXrryyOWXvfXCSsxSZLB3iAJHXbVgXCo72otMY+wCmfUajHB4
xwtUYiCxF8F/RcyMPKmWOI6eZKax20sJCy7o+Ai11qheYCT1uMC9PYN9/ZxK9/eH
3+COmjrSMfv4KNn2W0hZq6FvGvg/VVzzYWPe5W9P26kgY9rAahgsl9VEaenJt1QV
1ZQ+kf6D0XelyRsClMwohAIWaRx5Y8LrrI7IO88zAsEcaLGk068EuoLcIh0bxH+O
O72g7xyilvuSqKZqfO3pW0SHdCO+gqRSax00aHNPkZVMkyu1DNrpS9UHV6+9GifD
qjHb8u3PeQIDAQABo1MwUTAdBgNVHQ4EFgQUmxDTrJBEYhBZjqhcT6SveCi9Vnkw
HwYDVR0jBBgwFoAUmxDTrJBEYhBZjqhcT6SveCi9VnkwDwYDVR0TAQH/BAUwAwEB
/zANBgkqhkiG9w0BAQsFAAOCAQEAYzd7v2SAFnXD2W+VVwmDH/DAG0WzJC2X/o2f
jz5drM1TRWncIiGUJWfHP3+Qm58gn3dQc9CuFeK6xt1Se1zgF/+RrQMaOJnenes8
Nn6FitP0WmESFRUxt3K4ooqPnJ+No5JDUAnVmnGW5Zo6NnsQecfm3iLUTtWYZ1On
NxnUMdLoer8X9dKtBB8IP33Ot1SfNoeFqbhSJQItcxMYUeVJ4wJz3HEXUiFTpFu/
e85vZTuMsAGczl/m0Kvt40pu908/DLEGdeu55zmB+8d3FDDv8Zs/PEXp4L9snmnq
St0DaKibAdIuwqPJH5+NkLd78P8BBymApZoAcWbd1v0zPrd4vA==
-----END CERTIFICATE-----
`;
const CA = Buffer.from(CA_PEM).toString("base64");
const CLIENT_CERT = Buffer.from(CLIENT_CERT_PEM).toString("base64");
const CLIENT_KEY = Buffer.from(
  generateKeyPairSync("ec", { namedCurve: "prime256v1" })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString(),
).toString("base64");

function kubeconfig(overrides?: {
  cluster?: Record<string, unknown>;
  user?: Record<string, unknown>;
  context?: Record<string, unknown>;
  document?: Record<string, unknown>;
}): string {
  return yaml.dump({
    apiVersion: "v1",
    kind: "Config",
    "current-context": "workloads",
    clusters: [
      {
        name: "cluster-b",
        cluster: {
          server: "https://cluster-b.example.com:6443",
          "certificate-authority-data": CA,
          ...overrides?.cluster,
        },
      },
    ],
    users: [{ name: "deployer", user: overrides?.user ?? { token: "t0ken" } }],
    contexts: [
      {
        name: "workloads",
        context: {
          cluster: "cluster-b",
          user: "deployer",
          ...overrides?.context,
        },
      },
    ],
    ...overrides?.document,
  });
}

describe("parseEnvironmentKubeconfig", () => {
  test("keeps only the current context's cluster and user", () => {
    const content = yaml.dump({
      apiVersion: "v1",
      kind: "Config",
      "current-context": "workloads",
      clusters: [
        {
          name: "other",
          cluster: { server: "https://other.example.com" },
        },
        {
          name: "cluster-b",
          cluster: {
            server: "https://cluster-b.example.com:6443",
            "certificate-authority-data": CA,
          },
        },
      ],
      users: [
        { name: "admin", user: { token: "admin-token" } },
        { name: "deployer", user: { token: "t0ken" } },
      ],
      contexts: [
        { name: "other", context: { cluster: "other", user: "admin" } },
        {
          name: "workloads",
          context: {
            cluster: "cluster-b",
            user: "deployer",
            namespace: "ignored",
          },
        },
      ],
    });

    const parsed = parseEnvironmentKubeconfig(content);

    expect(parsed.server).toBe("https://cluster-b.example.com:6443");
    expect(yaml.load(parsed.normalized)).toEqual({
      apiVersion: "v1",
      kind: "Config",
      "current-context": "environment",
      clusters: [
        {
          name: "environment",
          cluster: {
            server: "https://cluster-b.example.com:6443",
            "certificate-authority-data": CA,
          },
        },
      ],
      users: [{ name: "environment", user: { token: "t0ken" } }],
      contexts: [
        {
          name: "environment",
          context: { cluster: "environment", user: "environment" },
        },
      ],
    });
    expect(parsed.normalized).not.toContain("admin-token");
  });

  test("accepts a client certificate credential", () => {
    const parsed = parseEnvironmentKubeconfig(
      kubeconfig({
        user: {
          "client-certificate-data": CLIENT_CERT,
          "client-key-data": CLIENT_KEY,
        },
      }),
    );

    expect(yaml.load(parsed.normalized)).toMatchObject({
      users: [
        {
          user: {
            "client-certificate-data": CLIENT_CERT,
            "client-key-data": CLIENT_KEY,
          },
        },
      ],
    });
  });

  test("gives the same cluster identity when only the credential changes", () => {
    const first = parseEnvironmentKubeconfig(kubeconfig());
    const rotated = parseEnvironmentKubeconfig(
      kubeconfig({ user: { token: "rotated" } }),
    );
    const otherServer = parseEnvironmentKubeconfig(
      kubeconfig({ cluster: { server: "https://cluster-c.example.com" } }),
    );

    expect(rotated.clusterIdentity).toBe(first.clusterIdentity);
    expect(otherServer.clusterIdentity).not.toBe(first.clusterIdentity);
  });

  test.each([
    ["exec", { exec: { command: "aws" } }],
    ["auth-provider", { "auth-provider": { name: "gcp" } }],
    ["tokenFile", { tokenFile: "/var/run/secrets/token" }],
    ["client-certificate", { "client-certificate": "/etc/cert.pem" }],
    ["client-key", { "client-key": "/etc/key.pem" }],
    ["username", { username: "admin", password: "hunter2" }],
    ["as", { token: "t0ken", as: "system:admin" }],
  ])("rejects a user with %s", (field, user) => {
    expect(() => parseEnvironmentKubeconfig(kubeconfig({ user }))).toThrow(
      new RegExp(`user field "${field}" is not supported`),
    );
  });

  test.each([
    ["certificate-authority", { "certificate-authority": "/etc/ca.pem" }],
    ["insecure-skip-tls-verify", { "insecure-skip-tls-verify": true }],
    ["proxy-url", { "proxy-url": "http://proxy.example.com" }],
    ["tls-server-name", { "tls-server-name": "other.example.com" }],
  ])("rejects a cluster with %s", (field, cluster) => {
    expect(() => parseEnvironmentKubeconfig(kubeconfig({ cluster }))).toThrow(
      new RegExp(`cluster field "${field}" is not supported`),
    );
  });

  test.each([
    ["plain http", "http://cluster-b.example.com"],
    ["credentials in the URL", "https://user:pass@cluster-b.example.com"],
    ["a query", "https://cluster-b.example.com/?x=1"],
    ["not a URL", "cluster-b"],
  ])("rejects a server with %s", (_name, server) => {
    expect(() =>
      parseEnvironmentKubeconfig(kubeconfig({ cluster: { server } })),
    ).toThrow(/cluster\.server/);
  });

  test("reads two spellings of one API server address as the same cluster", () => {
    const plain = parseEnvironmentKubeconfig(
      kubeconfig({ cluster: { server: "https://cluster-c.example.com" } }),
    );
    const spelled = parseEnvironmentKubeconfig(
      kubeconfig({
        cluster: { server: "https://CLUSTER-C.example.com.:443/" },
      }),
    );

    expect(spelled.server).toBe("https://cluster-c.example.com");
    expect(spelled.clusterIdentity).toBe(plain.clusterIdentity);
  });

  test("rejects a user with both a token and a client certificate", () => {
    expect(() =>
      parseEnvironmentKubeconfig(
        kubeconfig({
          user: {
            token: "t0ken",
            "client-certificate-data": CLIENT_CERT,
            "client-key-data": CLIENT_KEY,
          },
        }),
      ),
    ).toThrow(/exactly one credential/);
  });

  test("rejects a user with no credential", () => {
    expect(() => parseEnvironmentKubeconfig(kubeconfig({ user: {} }))).toThrow(
      /exactly one credential/,
    );
  });

  test("rejects a client certificate without its key", () => {
    expect(() =>
      parseEnvironmentKubeconfig(
        kubeconfig({ user: { "client-certificate-data": CLIENT_CERT } }),
      ),
    ).toThrow(/user\.client-key-data is missing/);
  });

  test("rejects certificate authority data that is not a certificate", () => {
    expect(() =>
      parseEnvironmentKubeconfig(
        kubeconfig({
          cluster: { "certificate-authority-data": "bm90IGEgY2VydA==" },
        }),
      ),
    ).toThrow(
      /certificate-authority-data is not a base64-encoded PEM certificate/,
    );
  });

  test("rejects a client key that is not a private key", () => {
    expect(() =>
      parseEnvironmentKubeconfig(
        kubeconfig({
          user: {
            "client-certificate-data": CLIENT_CERT,
            // A certificate where the key belongs.
            "client-key-data": CLIENT_CERT,
          },
        }),
      ),
    ).toThrow(/client-key-data is not a base64-encoded PEM private key/);
  });

  test("rejects a kubeconfig without a current context", () => {
    expect(() =>
      parseEnvironmentKubeconfig(
        kubeconfig({ document: { "current-context": "" } }),
      ),
    ).toThrow(/no current-context/);
  });

  test("rejects a current context that does not exist", () => {
    expect(() =>
      parseEnvironmentKubeconfig(
        kubeconfig({ document: { "current-context": "missing" } }),
      ),
    ).toThrow(/no context named "missing"/);
  });

  test("rejects a context whose cluster does not exist", () => {
    expect(() =>
      parseEnvironmentKubeconfig(
        kubeconfig({ context: { cluster: "missing" } }),
      ),
    ).toThrow(/no cluster named "missing"/);
  });

  test("rejects input that is not a YAML mapping", () => {
    expect(() => parseEnvironmentKubeconfig("- just\n- a list")).toThrow(
      EnvironmentKubeconfigError,
    );
    expect(() => parseEnvironmentKubeconfig("{ unclosed")).toThrow(
      /not valid YAML/,
    );
  });

  test("rejects a kubeconfig over the size limit", () => {
    expect(() =>
      parseEnvironmentKubeconfig(`# ${"x".repeat(64 * 1024)}\n${kubeconfig()}`),
    ).toThrow(/larger than 64 KiB/);
  });
});
