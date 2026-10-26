import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
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

// These source packages account for the inherited Debian findings in this image.
// The updater queries signed APT indexes; no repository/key/trust override is used.
const osPackages = [
  {
    name: "perl-base",
    argument: "PERL_BASE_VERSION",
    floor: "5.36.0-7+deb12u4",
  },
  { name: "libexpat1", argument: "EXPAT_VERSION", floor: "2.5.0-1+deb12u5" },
  { name: "libssl3", argument: "OPENSSL_VERSION", floor: "3.0.22-1~deb12u2" },
];

function compareBookwormVersion(a, b) {
  // Restrict this updater to reviewed Bookworm security version forms. A distro
  // or version-scheme change needs review rather than a guessed ordering.
  const pattern = /^(\d+)\.(\d+)\.(\d+)-(\d+)([+~])deb12u(\d+)$/;
  const left = pattern.exec(a);
  const right = pattern.exec(b);
  if (!left || !right || left[5] !== right[5])
    throw new Error(`Unsupported Bookworm package version: ${a} / ${b}`);
  for (const index of [1, 2, 3, 4, 6]) {
    const difference = Number(left[index]) - Number(right[index]);
    if (difference) return difference;
  }
  return 0;
}

function validateOsPackages(versions, previousVersions) {
  if (!versions || Object.keys(versions).length !== osPackages.length)
    throw new Error("Missing or unexpected Debian package pins");
  for (const { name, floor } of osPackages) {
    if (compareBookwormVersion(versions[name], floor) < 0)
      throw new Error(
        `${name} ${versions[name]} is below the fixed Debian version ${floor}`,
      );
    if (
      previousVersions &&
      compareBookwormVersion(versions[name], previousVersions[name]) < 0
    )
      throw new Error(`Refusing Debian package downgrade for ${name}`);
  }
}

function resolveOsPackages(nodeImage) {
  // Run only the official, digest-verified Node image, without host mounts or
  // credentials. APT verifies both architectures' indexes with its existing keys.
  const query = String.raw`
    const { execFileSync } = require("node:child_process");
    const names = JSON.parse(process.argv[1]);
    const native = execFileSync("dpkg", ["--print-architecture"], { encoding: "utf8" }).trim();
    if (!["amd64", "arm64"].includes(native)) throw new Error("Unsupported package query architecture");
    execFileSync("dpkg", ["--add-architecture", native === "amd64" ? "arm64" : "amd64"]);
    execFileSync("apt-get", ["update", "-qq"], { stdio: ["ignore", "ignore", "inherit"] });
    const versions = {};
    for (const name of names) {
      const candidates = ["amd64", "arm64"].map((arch) => {
        const policy = execFileSync("apt-cache", ["policy", name + ":" + arch], { encoding: "utf8" });
        const candidate = policy.match(/Candidate:\s*(\S+)/)?.[1];
        if (!candidate || candidate === "(none)") throw new Error("Missing " + name + " for " + arch);
        return candidate;
      });
      if (candidates[0] !== candidates[1]) throw new Error("Debian architectures disagree for " + name);
      versions[name] = candidates[0];
    }
    console.log(JSON.stringify(versions));
  `;
  return JSON.parse(
    execFileSync(
      process.env.PLAYWRIGHT_DOCKER_BIN || "docker",
      [
        "run",
        "--rm",
        "--user",
        "root",
        "--entrypoint",
        "node",
        nodeImage,
        "-e",
        query,
        JSON.stringify(osPackages.map(({ name }) => name)),
      ],
      { encoding: "utf8", timeout: 180_000, maxBuffer: 2_000_000 },
    ),
  );
}

function validate(metadata) {
  assertPatched(metadata.nodeVersion);
  validateOsPackages(metadata.osPackages);
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
  for (const key of [
    "ARG NODE_IMAGE",
    "ARG MCP_IMAGE",
    "ENV NODE_VERSION",
    ...osPackages.map(({ argument }) => `ARG ${argument}`),
  ]) {
    if (
      dockerfile.split("\n").filter((line) => line.startsWith(`${key}=`))
        .length !== 1
    )
      throw new Error(`Expected exactly one ${key} in Dockerfile`);
  }
  let rendered = dockerfile
    .replace(/^ARG NODE_IMAGE=.*$/m, `ARG NODE_IMAGE=${metadata.nodeImage}`)
    .replace(/^ARG MCP_IMAGE=.*$/m, `ARG MCP_IMAGE=${metadata.mcpImage}`)
    .replace(
      /^ENV NODE_VERSION=.*$/m,
      `ENV NODE_VERSION=${metadata.nodeVersion}`,
    );
  for (const { name, argument } of osPackages)
    rendered = rendered.replace(
      new RegExp(`^ARG ${argument}=.*$`, "m"),
      `ARG ${argument}=${metadata.osPackages[name]}`,
    );
  return rendered;
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
      "Playwright image inputs match their immutable metadata and patched Node/Debian floors",
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
    next.osPackages = resolveOsPackages(next.nodeImage);
    validateOsPackages(next.osPackages, previous.osPackages);
    validate(next);
    if (JSON.stringify(next) === JSON.stringify(previous))
      console.log("Playwright MCP image inputs already current");
    else {
      // Resolve and validate both architectures before writing any input.
      await writeFile(dockerfilePath, render(next));
      await writeFile(metadataPath, `${JSON.stringify(next, null, 2)}\n`);
      const debian = osPackages
        .map(
          ({ name }) =>
            `${name} ${previous.osPackages[name]} -> ${next.osPackages[name]}`,
        )
        .join(", ");
      console.log(
        `Updated Playwright MCP ${previous.mcpVersion} -> ${next.mcpVersion}, Node ${previous.nodeVersion} -> ${next.nodeVersion}; ${debian} (pinned image inputs)`,
      );
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
