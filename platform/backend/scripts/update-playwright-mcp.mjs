import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "image-dir": {
      type: "string",
      default: path.resolve(
        import.meta.dirname,
        "../../docker_images/playwright_mcp",
      ),
    },
    "cooldown-days": { type: "string", default: "7" },
    now: { type: "string" },
    check: { type: "boolean", default: false },
  },
});
const imageDir = values["image-dir"];
const metadataPath = path.join(imageDir, "versions.json");
const dockerfilePath = path.join(imageDir, "Dockerfile");
const previous = JSON.parse(await readFile(metadataPath, "utf8"));
const dockerfile = await readFile(dockerfilePath, "utf8");
const stable = /^\d+\.\d+\.\d+$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const accept =
  "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json";

function compare(a, b) {
  const aa = a.split(".").map(Number);
  const bb = b.split(".").map(Number);
  return aa[0] - bb[0] || aa[1] - bb[1] || aa[2] - bb[2];
}

function assertPatched(version) {
  // Fail closed on other major lines. Expand only after reviewing Node advisories.
  const minimum = { 22: "22.23.4", 24: "24.22.1", 26: "26.12.1" }[
    version?.split(".")[0]
  ];
  if (!stable.test(version) || !minimum || compare(version, minimum) < 0) {
    throw new Error(
      `Node ${version} is not an approved patched runtime for CVE-2026-111497`,
    );
  }
}

function validate(metadata) {
  assertPatched(metadata.nodeVersion);
  if (
    !stable.test(metadata.mcpVersion) ||
    !/^node:\d+\.\d+\.\d+-bookworm-slim@sha256:[a-f0-9]{64}$/.test(
      metadata.nodeImage,
    ) ||
    !/^mcr\.microsoft\.com\/playwright\/mcp@sha256:[a-f0-9]{64}$/.test(
      metadata.mcpImage,
    ) ||
    !metadata.nodeImage.startsWith(
      `node:${metadata.nodeVersion}-bookworm-slim@`,
    ) ||
    JSON.stringify(metadata.architectures) !== '["amd64","arm64"]'
  ) {
    throw new Error("Invalid Playwright image metadata");
  }
}

function render(metadata) {
  for (const key of ["ARG NODE_IMAGE", "ARG MCP_IMAGE", "ENV NODE_VERSION"]) {
    if (
      dockerfile.split("\n").filter((line) => line.startsWith(`${key}=`))
        .length !== 1
    )
      throw new Error(`Expected exactly one ${key} in Dockerfile`);
  }
  return dockerfile
    .replace(/^ARG NODE_IMAGE=.*$/m, `ARG NODE_IMAGE=${metadata.nodeImage}`)
    .replace(/^ARG MCP_IMAGE=.*$/m, `ARG MCP_IMAGE=${metadata.mcpImage}`)
    .replace(
      /^ENV NODE_VERSION=.*$/m,
      `ENV NODE_VERSION=${metadata.nodeVersion}`,
    );
}

async function request(url, token) {
  const response = await fetch(url, {
    headers: {
      Accept: accept,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    json: JSON.parse(bytes.toString()),
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

async function image({ registry, repository, tag, token }) {
  const base = `${registry}/v2/${repository}`;
  const index = await request(`${base}/manifests/${tag}`, token);
  const nodeVersions = [];
  for (const architecture of ["amd64", "arm64"]) {
    const manifest = index.json.manifests?.find(
      (entry) =>
        entry.platform?.os === "linux" &&
        entry.platform.architecture === architecture,
    );
    if (!digestPattern.test(manifest?.digest))
      throw new Error(
        `${repository}:${tag} has no linux/${architecture} manifest`,
      );
    const platform = await request(
      `${base}/manifests/${manifest.digest}`,
      token,
    );
    if (platform.digest !== manifest.digest)
      throw new Error("Platform manifest digest mismatch");
    if (!digestPattern.test(platform.json.config?.digest))
      throw new Error("Missing image config digest");
    const config = await request(
      `${base}/blobs/${platform.json.config.digest}`,
      token,
    );
    if (
      config.digest !== platform.json.config.digest ||
      config.json.architecture !== architecture
    )
      throw new Error("Image config digest/architecture mismatch");
    const version = config.json.config?.Env?.find((entry) =>
      entry.startsWith("NODE_VERSION="),
    )?.slice(13);
    if (!stable.test(version))
      throw new Error(`Missing Node version for ${architecture}`);
    nodeVersions.push(version);
  }
  if (nodeVersions[0] !== nodeVersions[1])
    throw new Error("Image architectures ship different Node versions");
  return { digest: index.digest, nodeVersion: nodeVersions[0] };
}

try {
  validate(previous);
  if (values.check) {
    if (render(previous) !== dockerfile)
      throw new Error("Dockerfile does not match versions.json");
    console.log(
      "Playwright image inputs match their immutable metadata and patched Node floor",
    );
  } else {
    const cooldown = Number(values["cooldown-days"]);
    const now = values.now ? Date.parse(values.now) : Date.now();
    if (!Number.isFinite(cooldown) || cooldown < 0 || !Number.isFinite(now))
      throw new Error("Invalid cooldown or clock");
    const npm = (
      process.env.NPM_CONFIG_REGISTRY || "https://registry.npmjs.org"
    ).replace(/\/$/, "");
    const packument = (await request(`${npm}/@playwright%2fmcp`)).json;
    const latest = packument["dist-tags"]?.latest;
    if (!stable.test(latest))
      throw new Error("MCP latest channel is not a stable version");
    const mcpVersion = Object.keys(packument.versions)
      .filter(
        (version) =>
          stable.test(version) &&
          compare(version, previous.mcpVersion) >= 0 &&
          compare(version, latest) <= 0 &&
          Number.isFinite(Date.parse(packument.time?.[version])) &&
          Date.parse(packument.time[version]) <= now - cooldown * 86_400_000,
      )
      .sort(compare)
      .at(-1);
    if (!mcpVersion)
      throw new Error("No non-downgrading MCP release outside the cooldown");
    const deps = packument.versions[mcpVersion].dependencies;
    if (!deps?.playwright || deps.playwright !== deps["playwright-core"])
      throw new Error("MCP Playwright dependencies disagree");
    const source = await image({
      registry:
        process.env.PLAYWRIGHT_MCR_REGISTRY || "https://mcr.microsoft.com",
      repository: "playwright/mcp",
      tag: `v${mcpVersion}`,
    });
    const auth = (
      await request(
        `${process.env.PLAYWRIGHT_NODE_AUTH || "https://auth.docker.io"}/token?service=registry.docker.io&scope=repository:library/node:pull`,
      )
    ).json;
    if (typeof auth.token !== "string" || !auth.token)
      throw new Error("Missing public Node registry pull token");
    // Track the existing major. Security patch rebuilds need not wait for the MCP cooldown.
    const node = await image({
      registry:
        process.env.PLAYWRIGHT_NODE_REGISTRY || "https://registry-1.docker.io",
      repository: "library/node",
      tag: `${previous.nodeVersion.split(".")[0]}-bookworm-slim`,
      token: auth.token,
    });
    assertPatched(node.nodeVersion);
    if (compare(node.nodeVersion, previous.nodeVersion) < 0)
      throw new Error("Refusing Node downgrade");
    const next = {
      ...previous,
      mcpVersion,
      mcpImage: `mcr.microsoft.com/playwright/mcp@${source.digest}`,
      sourceNodeVersion: source.nodeVersion,
      nodeVersion: node.nodeVersion,
      nodeImage: `node:${node.nodeVersion}-bookworm-slim@${node.digest}`,
      playwrightVersion: deps.playwright,
    };
    validate(next);
    if (JSON.stringify(next) === JSON.stringify(previous))
      console.log("Playwright MCP image inputs already current");
    else {
      // Resolve and validate both architectures before writing any input.
      await writeFile(dockerfilePath, render(next));
      await writeFile(metadataPath, `${JSON.stringify(next, null, 2)}\n`);
      console.log(
        `Updated Playwright MCP ${previous.mcpVersion} -> ${next.mcpVersion}, Node ${previous.nodeVersion} -> ${next.nodeVersion} (immutable image inputs)`,
      );
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
