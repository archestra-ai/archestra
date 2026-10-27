import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    file: {
      type: "string",
      default: path.resolve(
        import.meta.dirname,
        "../src/playwright-mcp-image.json",
      ),
    },
    "cooldown-days": { type: "string", default: "7" },
    now: { type: "string" },
    check: { type: "boolean", default: false },
  },
});
const stable = /^\d+\.\d+\.\d+$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const accept =
  "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json";
const previous = JSON.parse(await readFile(values.file, "utf8"));

function compare(a, b) {
  const aa = a.split(".").map(Number),
    bb = b.split(".").map(Number);
  return aa[0] - bb[0] || aa[1] - bb[1] || aa[2] - bb[2];
}
function validate(metadata) {
  if (
    !stable.test(metadata.mcpVersion) ||
    !stable.test(metadata.nodeVersion) ||
    typeof metadata.playwrightVersion !== "string" ||
    !metadata.playwrightVersion ||
    !/^mcr\.microsoft\.com\/playwright\/mcp@sha256:[a-f0-9]{64}$/.test(
      metadata.image,
    ) ||
    JSON.stringify(metadata.architectures) !== '["amd64","arm64"]'
  )
    throw new Error("Invalid upstream Playwright MCP image metadata");
}
async function request(url) {
  const response = await fetch(url, {
    headers: { Accept: accept },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    json: JSON.parse(bytes.toString()),
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}
async function upstreamImage(version) {
  const base = `${(process.env.PLAYWRIGHT_MCR_REGISTRY || "https://mcr.microsoft.com").replace(/\/$/, "")}/v2/playwright/mcp`;
  const index = await request(`${base}/manifests/v${version}`);
  const versions = [];
  for (const architecture of ["amd64", "arm64"]) {
    const entries = index.json.manifests?.filter(
      (entry) =>
        entry.platform?.os === "linux" &&
        entry.platform.architecture === architecture,
    );
    if (entries?.length !== 1 || !digestPattern.test(entries[0].digest))
      throw new Error(`Missing or ambiguous linux/${architecture} image`);
    const manifest = await request(`${base}/manifests/${entries[0].digest}`);
    if (
      manifest.digest !== entries[0].digest ||
      !digestPattern.test(manifest.json.config?.digest)
    )
      throw new Error("Image manifest digest mismatch");
    const config = await request(
      `${base}/blobs/${manifest.json.config.digest}`,
    );
    if (
      config.digest !== manifest.json.config.digest ||
      config.json.architecture !== architecture
    )
      throw new Error("Image config digest/architecture mismatch");
    const nodeVersion = config.json.config?.Env?.find((entry) =>
      entry.startsWith("NODE_VERSION="),
    )?.slice(13);
    if (!stable.test(nodeVersion))
      throw new Error(`Missing Node version for ${architecture}`);
    versions.push(nodeVersion);
  }
  if (versions[0] !== versions[1])
    throw new Error("Image architectures ship different Node versions");
  // Record upstream's actual runtime for review. This updater does not rebuild
  // images or represent an upstream release as a fix for a known vulnerability.
  return {
    image: `mcr.microsoft.com/playwright/mcp@${index.digest}`,
    nodeVersion: versions[0],
  };
}

try {
  validate(previous);
  if (values.check)
    console.log("Upstream Playwright MCP image metadata is valid");
  else {
    const days = Number(values["cooldown-days"]),
      now = values.now ? Date.parse(values.now) : Date.now();
    if (!Number.isFinite(days) || days < 0 || !Number.isFinite(now))
      throw new Error("Invalid cooldown or clock");
    const registry = (
      process.env.NPM_CONFIG_REGISTRY || "https://registry.npmjs.org"
    ).replace(/\/$/, "");
    const packument = (await request(`${registry}/@playwright%2fmcp`)).json;
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
          Date.parse(packument.time[version]) <= now - days * 86_400_000,
      )
      .sort(compare)
      .at(-1);
    if (!mcpVersion)
      throw new Error("No non-downgrading MCP release outside the cooldown");
    const deps = packument.versions[mcpVersion].dependencies;
    if (!deps?.playwright || deps.playwright !== deps["playwright-core"])
      throw new Error("MCP Playwright dependencies disagree");
    const next = {
      ...previous,
      mcpVersion,
      ...(await upstreamImage(mcpVersion)),
      playwrightVersion: deps.playwright,
    };
    validate(next);
    if (JSON.stringify(next) === JSON.stringify(previous))
      console.log("Upstream Playwright MCP image already current");
    else {
      await writeFile(values.file, `${JSON.stringify(next, null, 2)}\n`);
      console.log(
        `Updated upstream Playwright MCP ${previous.mcpVersion} -> ${next.mcpVersion} (Node ${next.nodeVersion}, immutable image digest)`,
      );
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
