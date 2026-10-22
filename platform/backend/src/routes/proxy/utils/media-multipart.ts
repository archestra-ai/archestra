import { Readable } from "node:stream";
import Busboy from "@fastify/busboy";
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

/** Fastify enforces route bodyLimit, including chunked wire bytes and headers. */
export async function registerMediaMultipartParser(
  fastify: FastifyInstance,
  options: { uploadTimeoutMs?: number } = {},
) {
  if (fastify.hasDecorator("boundedMediaMultipart")) return;
  fastify.decorate("boundedMediaMultipart", true);
  fastify.addHook("onRequest", (request, reply, done) => {
    if (
      !request.headers["content-type"]
        ?.toLowerCase()
        .startsWith("multipart/form-data")
    )
      return done();
    const cleanup = () => {
      clearTimeout(timer);
      request.raw.removeListener("end", cleanup);
      request.raw.removeListener("close", cleanup);
      reply.raw.removeListener("close", cleanup);
    };
    const timer = setTimeout(() => {
      cleanup();
      if (!reply.raw.headersSent) {
        reply.raw.once("finish", () => request.raw.destroy());
        void reply.code(408).send({
          error: {
            message: "Multipart upload deadline exceeded",
            type: "invalid_request_error",
          },
        });
      } else request.raw.destroy();
    }, options.uploadTimeoutMs ?? 120_000);
    timer.unref();
    request.raw.once("end", cleanup);
    request.raw.once("close", cleanup);
    reply.raw.once("close", cleanup);
    done();
  });
  fastify.addContentTypeParser(
    /^multipart\/form-data(?:;|$)/i,
    { parseAs: "buffer" },
    (request, body, done) => {
      // Middleware and errors must never serialize sensitive upload bytes.
      bodies.set(request, body as Buffer);
      done(null, undefined);
    },
  );
}

/** Bounded, memory-only parsing. No authentication, persistence, or logging. */
export async function parseMediaMultipart(
  request: FastifyRequest,
  limits: MediaMultipartLimits,
): Promise<{
  fields: Record<string, string | string[]>;
  files: MediaMultipartFile[];
}> {
  const raw = bodies.get(request);
  bodies.delete(request);
  if (!raw) throw new MediaMultipartError(415, "Expected multipart/form-data");
  const fields: Record<string, string | string[]> = Object.create(null);
  const files: MediaMultipartFile[] = [];
  const arrays = new Set(limits.arrayFields ?? []);
  let total = 0;
  return new Promise((resolve, reject) => {
    let parser: Busboy;
    try {
      parser = new Busboy({
        headers: {
          ...request.headers,
          "content-type": request.headers["content-type"] ?? "",
        },
        limits: {
          files: limits.maxFiles,
          fileSize: limits.maxFileBytes + 1,
          fields: limits.maxFields ?? 32,
          fieldSize: limits.maxFieldBytes ?? 64 * 1024,
          fieldNameSize: 128,
          headerPairs: 32,
          parts: limits.maxParts ?? 64,
        },
      });
    } catch {
      reject(new MediaMultipartError(400, "Invalid multipart boundary"));
      return;
    }
    let failed = false;
    const fail = (status: number, message: string) => {
      if (failed) return;
      failed = true;
      reject(new MediaMultipartError(status, message));
      parser.destroy();
    };
    const nameOf = (name: string) => {
      const canonical = name.endsWith("[]") ? name.slice(0, -2) : name;
      if (
        !canonical ||
        ["__proto__", "prototype", "constructor"].includes(canonical) ||
        hasControlCharacters(canonical) ||
        Buffer.byteLength(name) > 128 ||
        (name.endsWith("[]") && !arrays.has(canonical))
      ) {
        fail(400, "Invalid multipart field name");
        return undefined;
      }
      return canonical;
    };
    parser.on("file", (name, stream, originalFilename, _encoding, mimetype) => {
      const fieldname = nameOf(name);
      const filename =
        originalFilename
          .replaceAll("\\", "/")
          .split("/")
          .at(-1)
          ?.normalize("NFC") ?? "";
      if (
        !fieldname ||
        !limits.fileFields.includes(fieldname) ||
        (!arrays.has(fieldname) &&
          files.some((file) => file.fieldname === fieldname)) ||
        !filename ||
        filename === "." ||
        filename === ".." ||
        hasControlCharacters(filename) ||
        Buffer.byteLength(filename) > 255
      ) {
        stream.resume();
        fail(400, "Invalid or duplicate multipart file field");
        return;
      }
      const file: MediaMultipartFile = {
        fieldname,
        filename,
        mimetype,
        data: Buffer.alloc(0),
      };
      files.push(file);
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on("limit", () =>
        fail(413, "Multipart file exceeds the size limit"),
      );
      stream.on("error", () => fail(400, "Invalid multipart file"));
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        total += chunk.length;
        if (size > limits.maxFileBytes || total > limits.maxTotalFileBytes) {
          fail(413, "Multipart files exceed the size limit");
          return;
        }
        if (!failed) chunks.push(chunk);
      });
      stream.on("end", () => {
        if (!failed) file.data = Buffer.concat(chunks, size);
      });
    });
    parser.on("field", (name, value, nameTruncated, valueTruncated) => {
      const fieldname = nameOf(name);
      if (!fieldname) return;
      if (nameTruncated || valueTruncated) {
        fail(413, "Multipart field exceeds the size limit");
        return;
      }
      if (Object.hasOwn(fields, fieldname) && !arrays.has(fieldname)) {
        fail(400, "Duplicate multipart field");
        return;
      }
      fields[fieldname] = arrays.has(fieldname)
        ? [...((fields[fieldname] as string[]) ?? []), value]
        : value;
    });
    for (const event of ["partsLimit", "filesLimit", "fieldsLimit"] as const)
      parser.on(event, () =>
        fail(413, "Multipart part count exceeds the limit"),
      );
    parser.on("error", () => fail(400, "Invalid multipart body"));
    parser.on("finish", () => {
      if (!failed) resolve({ fields, files });
    });
    Readable.from(raw).pipe(parser);
  });
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

const bodies = new WeakMap<FastifyRequest, Buffer>();
