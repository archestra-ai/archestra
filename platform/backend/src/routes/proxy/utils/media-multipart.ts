import { Transform } from "node:stream";
import multipart from "@fastify/multipart";
import type { FastifyInstance, FastifyRequest } from "fastify";

export interface MediaMultipartFile {
  fieldname: string;
  filename: string;
  mimetype: string;
  data: Buffer;
}

export interface MediaMultipartLimits {
  fileFields: readonly string[];
  arrayFields?: readonly string[];
  maxFiles: number;
  maxFileBytes: number;
  maxTotalFileBytes: number;
  maxFields?: number;
  maxFieldBytes?: number;
  maxParts?: number;
}

/** Register once per route scope; parsing happens explicitly in the handler. */
export async function registerMediaMultipartParser(fastify: FastifyInstance) {
  if (fastify.hasRequestDecorator("parts")) return;
  await fastify.register(multipart, { throwFileSizeLimit: true });
  fastify.addHook("preParsing", (request, _reply, payload, done) => {
    if (
      !request.headers["content-type"]
        ?.toLowerCase()
        .startsWith("multipart/form-data")
    )
      return done(null, payload);
    const maximum = request.routeOptions.bodyLimit;
    const length = request.headers["content-length"];
    if (length && Number(length) > maximum) {
      return done(
        new MediaMultipartError(413, "Multipart body exceeds the size limit"),
      );
    }
    let received = 0;
    const bounded = new Transform({
      transform(chunk, _encoding, next) {
        received += chunk.length;
        next(
          received > maximum
            ? new MediaMultipartError(
                413,
                "Multipart body exceeds the size limit",
              )
            : null,
          chunk,
        );
      },
    });
    payload.once("error", (error) => bounded.destroy(error));
    done(null, payload.pipe(bounded));
  });
}

/** Bounded, memory-only upload parsing. Never authenticate, persist, or log here. */
export async function parseMediaMultipart(
  request: FastifyRequest,
  limits: MediaMultipartLimits,
): Promise<{
  fields: Record<string, string | string[]>;
  files: MediaMultipartFile[];
}> {
  if (!request.isMultipart())
    throw new MediaMultipartError(415, "Expected multipart/form-data");
  const fields: Record<string, string | string[]> = Object.create(null);
  const files: MediaMultipartFile[] = [];
  const arrays = new Set(limits.arrayFields ?? []);
  let total = 0;
  try {
    for await (const part of request.parts({
      limits: {
        files: limits.maxFiles,
        fileSize: limits.maxFileBytes,
        fields: limits.maxFields ?? 32,
        fieldSize: limits.maxFieldBytes ?? 64 * 1024,
        fieldNameSize: 128,
        headerPairs: 32,
        parts: limits.maxParts ?? 64,
      },
    })) {
      const fieldname = part.fieldname.endsWith("[]")
        ? part.fieldname.slice(0, -2)
        : part.fieldname;
      if (
        !fieldname ||
        ["__proto__", "prototype", "constructor"].includes(fieldname) ||
        hasControlCharacters(fieldname)
      ) {
        throw new MediaMultipartError(400, "Invalid multipart field name");
      }
      if (part.fieldname.endsWith("[]") && !arrays.has(fieldname))
        throw new MediaMultipartError(400, "Unexpected multipart array field");
      if (part.type === "file") {
        if (!limits.fileFields.includes(fieldname))
          throw new MediaMultipartError(400, "Unexpected multipart file field");
        if (
          !arrays.has(fieldname) &&
          files.some((file) => file.fieldname === fieldname)
        )
          throw new MediaMultipartError(400, "Duplicate multipart file field");
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of part.file) {
          const bytes = Buffer.from(chunk);
          size += bytes.length;
          total += bytes.length;
          if (size > limits.maxFileBytes || total > limits.maxTotalFileBytes)
            throw new MediaMultipartError(
              413,
              "Multipart files exceed the size limit",
            );
          chunks.push(bytes);
        }
        if (part.file.truncated)
          throw new MediaMultipartError(
            413,
            "Multipart file exceeds the size limit",
          );
        const filename =
          part.filename
            .replaceAll("\\", "/")
            .split("/")
            .at(-1)
            ?.normalize("NFC") ?? "";
        if (
          !filename ||
          filename === "." ||
          filename === ".." ||
          hasControlCharacters(filename) ||
          Buffer.byteLength(filename) > 255
        )
          throw new MediaMultipartError(400, "Invalid multipart filename");
        files.push({
          fieldname,
          filename,
          mimetype: part.mimetype,
          data: Buffer.concat(chunks, size),
        });
      } else {
        if (part.valueTruncated || part.fieldnameTruncated)
          throw new MediaMultipartError(
            413,
            "Multipart field exceeds the size limit",
          );
        if (typeof part.value !== "string")
          throw new MediaMultipartError(
            400,
            "Multipart fields must be strings",
          );
        if (Object.hasOwn(fields, fieldname) && !arrays.has(fieldname))
          throw new MediaMultipartError(400, "Duplicate multipart field");
        fields[fieldname] = arrays.has(fieldname)
          ? [...((fields[fieldname] as string[]) ?? []), part.value]
          : part.value;
      }
    }
    return { fields, files };
  } catch (error) {
    if (error instanceof MediaMultipartError) throw error;
    const code = (error as { code?: string }).code;
    throw new MediaMultipartError(
      code?.includes("LIMIT") || code?.includes("TOO_LARGE") ? 413 : 400,
      "Invalid or oversized multipart body",
    );
  }
}

class MediaMultipartError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "MediaMultipartError";
  }
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}
