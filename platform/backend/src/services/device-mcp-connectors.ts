import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const ConnectorTargetSchema = z
  .object({
    platform: z.enum(["darwin", "win32"]),
    arch: z.enum(["arm64", "x64"]),
  })
  .strict();
const ConnectorArtifactBaseSchema = ConnectorTargetSchema.extend({
  version: z.string().min(1).max(128),
  appName: z.string().min(1).max(100),
  productName: z.string().min(1).max(108),
  protocol: z.literal("archestra-device"),
  filename: z.string().regex(/^[a-z0-9-]+\.zip$/),
  bytes: z
    .number()
    .int()
    .positive()
    .max(256 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const ReleaseConnectorArtifactSchema = ConnectorArtifactBaseSchema.extend({
  signed: z.literal(true),
  development: z.literal(false).optional(),
  verification: z
    .object({
      mac: z
        .object({ developerId: z.literal(true), notarized: z.literal(true) })
        .strict()
        .optional(),
      windows: z
        .object({ authenticode: z.literal(true) })
        .strict()
        .optional(),
    })
    .strict(),
}).strict();

const DevelopmentConnectorArtifactSchema = ConnectorArtifactBaseSchema.extend({
  platform: z.literal("darwin"),
  signed: z.literal(false),
  development: z.literal(true),
  verification: z
    .object({
      mac: z
        .object({
          adHocIntegrity: z.literal(true),
          developerId: z.literal(false),
          notarized: z.literal(false),
        })
        .strict(),
    })
    .strict(),
}).strict();
export const ConnectorArtifactSchema = z.union([
  ReleaseConnectorArtifactSchema,
  DevelopmentConnectorArtifactSchema,
]);

type DevelopmentConnectorRequest = {
  directory: string | undefined;
  enabled: boolean;
  frontendBaseUrl: string;
  remoteAddress: string | undefined;
};

/** Uses the actual socket peer, never proxy headers or caller-provided origins. */
function developmentDirectory(
  request: DevelopmentConnectorRequest | undefined,
) {
  if (
    !request?.enabled ||
    !request.directory ||
    !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
      request.remoteAddress ?? "",
    )
  )
    return undefined;
  try {
    const frontend = new URL(request.frontendBaseUrl);
    if (
      !["http:", "https:"].includes(frontend.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(frontend.hostname) ||
      frontend.username ||
      frontend.password ||
      frontend.search ||
      frontend.hash ||
      frontend.pathname !== "/"
    )
      return undefined;
    return request.directory;
  } catch {
    return undefined;
  }
}

const verifiedArtifacts = new Map<string, string>();
const targets = [
  { platform: "darwin", arch: "arm64" },
  { platform: "darwin", arch: "x64" },
  { platform: "win32", arch: "x64" },
] as const;

/** Release-build identity: never turn display branding into an arbitrary path.
 * @public — shared contract with the native release builder. */
export function connectorIdentity(
  appName: string,
  target: z.infer<typeof ConnectorTargetSchema>,
) {
  if (
    !appName ||
    appName.length > 100 ||
    appName !== appName.trim() ||
    appName !== appName.normalize("NFKC") ||
    /[\p{C}/\\<>:"|?*]/u.test(appName) ||
    /[. ]$/.test(appName)
  )
    return null;
  const productName = /desktop$/i.test(appName)
    ? appName
    : `${appName} Desktop`;
  const slug =
    productName
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "desktop";
  const brandHash = createHash("sha256")
    .update(appName, "utf8")
    .digest("hex")
    .slice(0, 10);
  return {
    appName,
    productName,
    filename: `${slug}-${brandHash}-${target.platform}-${target.arch}.zip`,
  };
}

/** Both fields are derived from validated branding; no raw header interpolation. */
export function connectorContentDisposition(
  artifact: z.infer<typeof ConnectorArtifactSchema>,
) {
  const friendly = `${artifact.productName}-${artifact.platform}-${artifact.arch}.zip`;
  const encoded = encodeURIComponent(friendly).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${artifact.filename}"; filename*=UTF-8''${encoded}`;
}

const fingerprint = (metadata: BigIntStats) =>
  `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}`;
const readOnly =
  constants.O_RDONLY |
  (constants.O_NOFOLLOW ?? 0) |
  (constants.O_NONBLOCK ?? 0);

async function readManifest(
  directory: string,
  target: z.infer<typeof ConnectorTargetSchema>,
  mode: "release" | "development",
) {
  const file = await open(
    join(directory, `${target.platform}-${target.arch}.json`),
    readOnly,
  );
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > 4096n || before.size === 0n)
      return null;
    const contents = Buffer.alloc(4097);
    const { bytesRead } = await file.read(contents, 0, contents.length, 0);
    if (BigInt(bytesRead) !== before.size || bytesRead > 4096) return null;
    const after = await file.stat({ bigint: true });
    if (fingerprint(before) !== fingerprint(after)) return null;
    return (
      mode === "release"
        ? ReleaseConnectorArtifactSchema
        : DevelopmentConnectorArtifactSchema
    ).parse(JSON.parse(contents.subarray(0, bytesRead).toString("utf8")));
  } finally {
    await file.close();
  }
}

/**
 * The directory is a trusted, read-only release-pipeline output. Its manifest
 * attests native Developer ID + notarization / Authenticode verification of
 * the final archive; this platform-neutral server independently checks brand,
 * target, release policy and bytes. It cannot notarize or re-sign packages.
 */
async function verifiedDeviceConnector(
  directory: string | undefined,
  target: z.infer<typeof ConnectorTargetSchema>,
  appName: string,
  mode: "release" | "development" = "release",
) {
  const identity = connectorIdentity(appName, target);
  if (
    !directory ||
    !identity ||
    !targets.some(
      (item) => item.platform === target.platform && item.arch === target.arch,
    )
  )
    return null;
  let file: FileHandle | undefined;
  try {
    const artifact = await readManifest(directory, target, mode);
    if (
      !artifact ||
      artifact.appName !== identity.appName ||
      artifact.productName !== identity.productName ||
      artifact.filename !== identity.filename ||
      artifact.platform !== target.platform ||
      artifact.arch !== target.arch
    )
      return null;
    const hasMac =
      "mac" in artifact.verification && !!artifact.verification.mac;
    const hasWindows =
      "windows" in artifact.verification && !!artifact.verification.windows;
    if (
      target.platform === "darwin"
        ? !hasMac || hasWindows
        : !hasWindows || hasMac
    )
      return null;
    const path = join(directory, artifact.filename);
    file = await open(path, readOnly);
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size !== BigInt(artifact.bytes)) {
      await file.close();
      return null;
    }
    const cacheKey = `${path}:${fingerprint(before)}:${artifact.sha256}`;
    if (!verifiedArtifacts.has(cacheKey)) {
      const hash = createHash("sha256");
      for await (const chunk of file.createReadStream({
        start: 0,
        end: artifact.bytes - 1,
        autoClose: false,
      }))
        hash.update(chunk);
      if (hash.digest("hex") !== artifact.sha256) {
        await file.close();
        return null;
      }
    }
    const after = await file.stat({ bigint: true });
    if (fingerprint(before) !== fingerprint(after)) {
      await file.close();
      return null;
    }
    if (!verifiedArtifacts.has(cacheKey)) {
      if (verifiedArtifacts.size >= targets.length) {
        const oldest = verifiedArtifacts.keys().next().value;
        if (oldest) verifiedArtifacts.delete(oldest);
      }
      verifiedArtifacts.set(cacheKey, artifact.sha256);
    }
    return { artifact, file };
  } catch {
    await file?.close();
    return null;
  }
}

export async function listDeviceConnectors(
  directory: string | undefined,
  appName: string,
  development?: DevelopmentConnectorRequest,
) {
  const previewDirectory = developmentDirectory(development);
  const artifacts = await Promise.all(
    targets.map(async (target) => {
      const result =
        (await verifiedDeviceConnector(directory, target, appName)) ??
        (previewDirectory
          ? await verifiedDeviceConnector(
              previewDirectory,
              target,
              appName,
              "development",
            )
          : null);
      if (!result) return null;
      await result.file.close();
      return result.artifact;
    }),
  );
  return artifacts.filter(
    (artifact): artifact is z.infer<typeof ConnectorArtifactSchema> =>
      artifact !== null,
  );
}

/** Download from the same descriptor that was verified, without following links. */
export async function openDeviceConnector(
  directory: string | undefined,
  target: z.infer<typeof ConnectorTargetSchema>,
  appName: string,
  development?: DevelopmentConnectorRequest,
) {
  const previewDirectory = developmentDirectory(development);
  const result =
    (await verifiedDeviceConnector(directory, target, appName)) ??
    (previewDirectory
      ? await verifiedDeviceConnector(
          previewDirectory,
          target,
          appName,
          "development",
        )
      : null);
  if (!result) return null;
  return {
    artifact: result.artifact,
    stream: result.file.createReadStream({
      start: 0,
      end: result.artifact.bytes - 1,
      autoClose: true,
    }),
  };
}
