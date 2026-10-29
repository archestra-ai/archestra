import { HttpResponse, http } from "msw";
import { describe, expect, test } from "vitest";
import { useMswServer } from "@/test/msw";
import { containerRegistryClient } from "./container-registry";

const DIGEST = `sha256:${"a".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"b".repeat(64)}`;

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper.
const server = useMswServer();

describe("containerRegistryClient.getTagDigest", () => {
  test("resolves a Docker Hub short name through the anonymous Bearer challenge", async () => {
    const seen: { accept: string | null; tokenAuth: string | null } = {
      accept: null,
      tokenAuth: "unset",
    };
    server.use(
      http.head(
        "https://registry-1.docker.io/v2/library/nginx/manifests/latest",
        ({ request }) => {
          if (request.headers.get("authorization") !== "Bearer anon-token") {
            return new HttpResponse(null, {
              status: 401,
              headers: {
                "WWW-Authenticate":
                  'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"',
              },
            });
          }
          seen.accept = request.headers.get("accept");
          return new HttpResponse(null, {
            headers: { "Docker-Content-Digest": DIGEST },
          });
        },
      ),
      http.get("https://auth.docker.io/token", ({ request }) => {
        const url = new URL(request.url);
        seen.tokenAuth = request.headers.get("authorization");
        expect(url.searchParams.get("service")).toBe("registry.docker.io");
        expect(url.searchParams.get("scope")).toBe(
          "repository:library/nginx:pull",
        );
        return HttpResponse.json({ token: "anon-token", expires_in: 300 });
      }),
    );

    await expect(
      containerRegistryClient.getTagDigest({ image: "nginx" }),
    ).resolves.toBe(DIGEST);
    expect(seen.tokenAuth).toBeNull();
    // Same Accept set a node pulls with, so multi-arch tags resolve to the
    // index digest the runtime reports.
    expect(seen.accept).toContain("application/vnd.oci.image.index.v1+json");
    expect(seen.accept).toContain(
      "application/vnd.docker.distribution.manifest.list.v2+json",
    );
  });

  test("authenticates at the token realm with pull-secret credentials and reuses the token", async () => {
    let tokenRequests = 0;
    let tokenAuth: string | null = null;
    server.use(
      http.head(
        "https://ghcr.io/v2/acme/private-server/manifests/latest",
        ({ request }) => {
          if (request.headers.get("authorization") !== "Bearer private-token") {
            return new HttpResponse(null, {
              status: 401,
              headers: {
                "WWW-Authenticate":
                  'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:acme/private-server:pull"',
              },
            });
          }
          return new HttpResponse(null, {
            headers: { "Docker-Content-Digest": DIGEST },
          });
        },
      ),
      http.get("https://ghcr.io/token", ({ request }) => {
        tokenRequests += 1;
        tokenAuth = request.headers.get("authorization");
        return HttpResponse.json({ token: "private-token" });
      }),
    );
    const dockerConfig = JSON.stringify({
      auths: {
        "https://ghcr.io": {
          auth: Buffer.from("bot:s3cret").toString("base64"),
        },
      },
    });

    for (let i = 0; i < 2; i++) {
      await expect(
        containerRegistryClient.getTagDigest({
          image: "ghcr.io/acme/private-server:latest",
          dockerConfigs: [dockerConfig],
        }),
      ).resolves.toBe(DIGEST);
    }
    expect(tokenAuth).toBe(
      `Basic ${Buffer.from("bot:s3cret").toString("base64")}`,
    );
    expect(tokenRequests).toBe(1);
  });

  test("answers a Basic challenge on a registry with a port using legacy dockercfg credentials", async () => {
    server.use(
      http.head(
        "https://registry.example.com:5000/v2/team/server/manifests/latest",
        ({ request }) => {
          const expected = `Basic ${Buffer.from("ci:pw").toString("base64")}`;
          if (request.headers.get("authorization") !== expected) {
            return new HttpResponse(null, {
              status: 401,
              headers: { "WWW-Authenticate": 'Basic realm="registry"' },
            });
          }
          return new HttpResponse(null, {
            headers: { "Docker-Content-Digest": DIGEST },
          });
        },
      ),
    );

    await expect(
      containerRegistryClient.getTagDigest({
        image: "registry.example.com:5000/team/server",
        dockerConfigs: [
          JSON.stringify({
            "registry.example.com:5000": { username: "ci", password: "pw" },
          }),
        ],
      }),
    ).resolves.toBe(DIGEST);
  });

  test("falls back to GET when HEAD carries no digest header", async () => {
    server.use(
      http.head(
        "https://quay.io/v2/acme/headless/manifests/latest",
        () => new HttpResponse(null),
      ),
      http.get(
        "https://quay.io/v2/acme/headless/manifests/latest",
        () =>
          new HttpResponse("{}", {
            headers: { "Docker-Content-Digest": OTHER_DIGEST },
          }),
      ),
    );

    await expect(
      containerRegistryClient.getTagDigest({
        image: "quay.io/acme/headless",
      }),
    ).resolves.toBe(OTHER_DIGEST);
  });

  test("rejects when the registry rate-limits the lookup", async () => {
    server.use(
      http.head(
        "https://registry-1.docker.io/v2/acme/busy/manifests/latest",
        () => new HttpResponse(null, { status: 429 }),
      ),
    );

    await expect(
      containerRegistryClient.getTagDigest({ image: "acme/busy:latest" }),
    ).rejects.toThrow(/rate-limited/);
  });
});
