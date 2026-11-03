import { createHash } from "node:crypto";
import { mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  connectorContentDisposition,
  connectorIdentity,
  listDeviceConnectors,
  openDeviceConnector,
} from "./device-mcp-connectors";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture(
  appName = "Archestra",
  platform: "darwin" | "win32" = "darwin",
) {
  const directory = await mkdtemp(join(tmpdir(), "device-connector-"));
  directories.push(directory);
  const bytes = Buffer.from(
    "synthetic archive: signing attestation is a release-pipeline boundary",
  );
  const arch = platform === "darwin" ? ("arm64" as const) : ("x64" as const);
  const identity = connectorIdentity(appName, { platform, arch });
  if (!identity) throw new Error("Invalid fixture identity");
  const manifest = {
    version: "1.0.0",
    platform,
    arch,
    ...identity,
    protocol: "archestra-device" as const,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    signed: true as const,
    verification:
      platform === "darwin"
        ? { mac: { developerId: true as const, notarized: true as const } }
        : { windows: { authenticode: true as const } },
  };
  const manifestPath = join(directory, `${platform}-${arch}.json`);
  await writeFile(join(directory, manifest.filename), bytes);
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { directory, manifest, manifestPath, bytes };
}
async function collect(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("branded release connector downloads", () => {
  test("lists only matching branded, release-attested and digest-verified artifacts", async () => {
    const { directory, manifest } = await fixture("Acme AI");
    expect(await listDeviceConnectors(directory, "Acme AI")).toEqual([
      manifest,
    ]);
    expect(await listDeviceConnectors(directory, "Archestra")).toEqual([]);
    await writeFile(
      join(directory, manifest.filename),
      "X".repeat(manifest.bytes),
    );
    expect(await listDeviceConnectors(directory, "Acme AI")).toEqual([]);
  });
  test("fails closed for unsigned, development, unnotarized, wrong-signature-target and old manifests", async () => {
    const { directory, manifest, manifestPath } = await fixture();
    for (const changed of [
      { signed: false },
      { development: true },
      { verification: {} },
      { verification: { mac: { developerId: false, notarized: true } } },
      { verification: { mac: { developerId: true, notarized: false } } },
      { verification: { windows: { authenticode: true } } },
      { appName: "Other" },
      { productName: "Other Desktop" },
      { protocol: "arbitrary" },
      {
        appName: undefined,
        productName: undefined,
        protocol: undefined,
        verification: undefined,
      },
    ]) {
      await writeFile(
        manifestPath,
        JSON.stringify({ ...manifest, ...changed }),
      );
      expect(await listDeviceConnectors(directory, "Archestra")).toEqual([]);
      expect(
        await openDeviceConnector(
          directory,
          { platform: "darwin", arch: "arm64" },
          "Archestra",
        ),
      ).toBeNull();
    }
  });
  test("requires Authenticode attestation for Windows", async () => {
    const { directory, manifest, manifestPath } = await fixture(
      "Acme",
      "win32",
    );
    expect(await listDeviceConnectors(directory, "Acme")).toEqual([manifest]);
    await writeFile(
      manifestPath,
      JSON.stringify({
        ...manifest,
        verification: { windows: { authenticode: false } },
      }),
    );
    expect(await listDeviceConnectors(directory, "Acme")).toEqual([]);
  });
  test("refuses traversal, mismatched targets, symlink manifests and symlink artifacts", async () => {
    const { directory, manifest, manifestPath } = await fixture();
    for (const changed of [
      { filename: "../outside.zip" },
      { filename: "evil\r\nheader.zip" },
      { platform: "win32" },
      { bytes: 300 * 1024 * 1024 },
    ]) {
      await writeFile(
        manifestPath,
        JSON.stringify({ ...manifest, ...changed }),
      );
      expect(
        await openDeviceConnector(
          directory,
          { platform: "darwin", arch: "arm64" },
          "Archestra",
        ),
      ).toBeNull();
    }
    await writeFile(manifestPath, JSON.stringify(manifest));
    await rm(join(directory, manifest.filename));
    await symlink(manifestPath, join(directory, manifest.filename));
    expect(await listDeviceConnectors(directory, "Archestra")).toEqual([]);
    await rm(manifestPath);
    await symlink(join(directory, manifest.filename), manifestPath);
    expect(await listDeviceConnectors(directory, "Archestra")).toEqual([]);
    expect(await listDeviceConnectors(undefined, "Archestra")).toEqual([]);
  });
  test("keeps Unicode brands distinct and emits encoded safe download names", async () => {
    const { directory, manifest } = await fixture("Équipe 智能");
    expect(await listDeviceConnectors(directory, "Équipe 智能")).toEqual([
      manifest,
    ]);
    const header = connectorContentDisposition(manifest);
    expect(header).toContain(`filename="${manifest.filename}"`);
    expect(header).toContain(
      "filename*=UTF-8''%C3%89quipe%20%E6%99%BA%E8%83%BD%20Desktop",
    );
    expect(header).not.toMatch(/[\r\n]/);
    const sameSlug = connectorIdentity("Equipe 智能", {
      platform: "darwin",
      arch: "arm64",
    });
    expect(sameSlug?.filename).not.toBe(manifest.filename);
    // Cyrillic A looks like Latin A but must never select Latin branding.
    expect(await listDeviceConnectors(directory, "Еquipe 智能")).toEqual([]);
  });
  test("rejects unsupported bundle names instead of evaluating or silently normalizing them", async () => {
    const target = { platform: "darwin", arch: "arm64" } as const;
    for (const name of [
      "../Acme",
      "Acme/../../x",
      "Acme\\file",
      "Acme\nInjected",
      "Acme\u202Ezip",
      "Ａrchestra",
      "Acme.",
      " Acme",
      "Acme ",
      "Acme:Tools",
      "Acme\u0000",
      "",
    ])
      expect(connectorIdentity(name, target), name).toBeNull();
    expect(connectorIdentity("Acme Desktop", target)?.productName).toBe(
      "Acme Desktop",
    );
  });
  test("returns a stream for the verified descriptor even if the path is replaced afterward", async () => {
    const { directory, manifest, bytes } = await fixture();
    const result = await openDeviceConnector(
      directory,
      { platform: "darwin", arch: "arm64" },
      "Archestra",
    );
    expect(result).not.toBeNull();
    if (!result) throw new Error("Expected a verified descriptor");
    const path = join(directory, manifest.filename);
    await rename(path, `${path}.old`);
    await writeFile(path, "X".repeat(manifest.bytes));
    expect(await collect(result.stream)).toEqual(bytes);
    expect(await listDeviceConnectors(directory, "Archestra")).toEqual([]);
  });
  test("does not let a cached artifact mask same-size mutations or a swapped release policy", async () => {
    const { directory, manifest, manifestPath } = await fixture();
    expect(await listDeviceConnectors(directory, "Archestra")).toHaveLength(1);
    await writeFile(
      manifestPath,
      JSON.stringify({ ...manifest, signed: false }),
    );
    expect(await listDeviceConnectors(directory, "Archestra")).toEqual([]);
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(
      join(directory, manifest.filename),
      Buffer.alloc(manifest.bytes),
    );
    expect(
      await openDeviceConnector(
        directory,
        { platform: "darwin", arch: "arm64" },
        "Archestra",
      ),
    ).toBeNull();
  });
});

describe("explicit local development connector fallback", () => {
  async function preview() {
    const value = await fixture();
    const manifest = {
      ...value.manifest,
      signed: false as const,
      development: true as const,
      verification: {
        mac: {
          adHocIntegrity: true as const,
          developerId: false as const,
          notarized: false as const,
        },
      },
    };
    await writeFile(value.manifestPath, JSON.stringify(manifest));
    const options = {
      directory: value.directory,
      enabled: true,
      frontendBaseUrl: "http://localhost:13500",
      remoteAddress: "127.0.0.1",
    };
    return { ...value, manifest, options };
  }
  test("offers an integrity-checked unsigned Mac build only through explicitly enabled local preview", async () => {
    const { directory, manifest, options, bytes } = await preview();
    expect(await listDeviceConnectors(directory, "Archestra")).toEqual([]);
    expect(await listDeviceConnectors(undefined, "Archestra", options)).toEqual(
      [manifest],
    );
    const result = await openDeviceConnector(
      undefined,
      { platform: "darwin", arch: "arm64" },
      "Archestra",
      options,
    );
    if (!result) throw new Error("Expected explicit local preview");
    expect(result.artifact).toMatchObject({
      signed: false,
      development: true,
      verification: {
        mac: { adHocIntegrity: true, developerId: false, notarized: false },
      },
    });
    expect(await collect(result.stream)).toEqual(bytes);
  });
  test("rejects production mode, nonlocal deployments and nonloopback sockets even with configured preview files", async () => {
    const { options } = await preview();
    for (const changed of [
      { enabled: false },
      { directory: undefined },
      { remoteAddress: undefined },
      { remoteAddress: "203.0.113.1" },
      { remoteAddress: "127.0.0.1.evil.test" },
      { frontendBaseUrl: "https://demo.example.com" },
      { frontendBaseUrl: "http://localhost.evil.test" },
      { frontendBaseUrl: "http://127.0.0.2" },
      { frontendBaseUrl: "http://user:secret@localhost" },
      { frontendBaseUrl: "http://localhost/path" },
      { frontendBaseUrl: "http://localhost?preview=true" },
    ]) {
      expect(
        await listDeviceConnectors(undefined, "Archestra", {
          ...options,
          ...changed,
        }),
      ).toEqual([]);
    }
    for (const remoteAddress of ["::1", "::ffff:127.0.0.1"])
      expect(
        await listDeviceConnectors(undefined, "Archestra", {
          ...options,
          remoteAddress,
        }),
      ).toHaveLength(1);
  });
  test("keeps the signed release preferred and refuses unsigned legacy or mismatched preview manifests", async () => {
    const release = await fixture();
    const { manifest, manifestPath, options } = await preview();
    expect(
      await listDeviceConnectors(release.directory, "Archestra", options),
    ).toEqual([release.manifest]);
    for (const changed of [
      { development: false },
      { development: undefined },
      { appName: "Other" },
      { signed: true },
      { verification: { mac: { developerId: false, notarized: false } } },
      {
        verification: {
          mac: { adHocIntegrity: false, developerId: false, notarized: false },
        },
      },
    ]) {
      await writeFile(
        manifestPath,
        JSON.stringify({ ...manifest, ...changed }),
      );
      expect(
        await listDeviceConnectors(undefined, "Archestra", options),
      ).toEqual([]);
    }
  });
});
