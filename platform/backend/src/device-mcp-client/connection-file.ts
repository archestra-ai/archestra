import { z } from "zod";

const LegacyConnectionFileSchema = z
  .object({
    version: z.literal(1),
    url: z.string().url().max(2048),
    code: z.string().regex(/^[A-Za-z0-9_-]{40,128}$/),
  })
  .strict();

const LocalDeviceConnectionFileSchema = z
  .object({
    version: z.literal(2),
    purpose: z.literal("local-device"),
    url: z.string().url().max(2048),
    code: z.string().regex(/^[A-Za-z0-9_-]{40,128}$/),
  })
  .strict();
const ConnectionFileSchema = z.union([
  LegacyConnectionFileSchema,
  LocalDeviceConnectionFileSchema,
]);

/** A setup file is a pairing proof, never an executable launch manifest. */
export function parseDeviceConnectionFile(contents: string) {
  if (Buffer.byteLength(contents, "utf8") > 4096) {
    throw new Error(
      "This connection file is too large. Download it again from Connect.",
    );
  }
  const file = ConnectionFileSchema.parse(JSON.parse(contents));
  const origin = new URL(file.url);
  if (
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    (origin.pathname !== "/" && origin.pathname !== "") ||
    (origin.protocol !== "https:" &&
      !(
        origin.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
      ))
  ) {
    throw new Error(
      "The connection must use HTTPS and a deployment origin. Localhost HTTP is allowed for development.",
    );
  }
  return { ...file, url: origin.origin };
}
