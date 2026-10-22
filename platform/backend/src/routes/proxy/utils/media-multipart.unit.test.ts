import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import Fastify from "fastify";
import { describe, expect, test } from "vitest";
import {
  parseMediaMultipart,
  registerMediaMultipartParser,
} from "./media-multipart";

const bytes = new Uint8Array([0, 255, 128, 13, 10, 45, 45, 1]);

async function upload(
  form: FormData,
  options: {
    bodyLimit?: number;
    maxFileBytes?: number;
    maxTotalFileBytes?: number;
  } = {},
) {
  const app = Fastify({ bodyLimit: options.bodyLimit ?? 8192 });
  await registerMediaMultipartParser(app);
  app.post("/upload", async (request) => {
    const parsed = await parseMediaMultipart(request, {
      fileFields: ["file", "image", "mask"],
      arrayFields: ["image", "include"],
      maxFiles: 3,
      maxFileBytes: options.maxFileBytes ?? 64,
      maxTotalFileBytes: options.maxTotalFileBytes ?? 128,
      maxFields: 4,
      maxFieldBytes: 32,
      maxParts: 7,
    });
    return {
      fields: parsed.fields,
      files: parsed.files.map(({ data, ...file }) => ({
        ...file,
        size: data.length,
        hash: createHash("sha256").update(data).digest("hex"),
      })),
    };
  });
  const wire = new Request("http://upload.test", {
    method: "POST",
    body: form,
  });
  try {
    return await app.inject({
      method: "POST",
      url: "/upload",
      headers: { "content-type": wire.headers.get("content-type") ?? "" },
      payload: Buffer.from(await wire.arrayBuffer()),
    });
  } finally {
    await app.close();
  }
}

describe("bounded multipart parsing", () => {
  test.each([
    "__proto__",
    "constructor",
    "toString",
    "epilogue",
    "oversized-boundary",
  ])("handles adversarial multipart %s without parser crashes or event-loop stalls", async (kind) => {
    const app = Fastify();
    await registerMediaMultipartParser(app);
    app.post(
      "/",
      async (request) =>
        (
          await parseMediaMultipart(request, {
            fileFields: ["file"],
            maxFiles: 1,
            maxFileBytes: 64,
            maxTotalFileBytes: 64,
          })
        ).fields,
    );
    const boundary =
      kind === "oversized-boundary" ? "x".repeat(252) : "safe-boundary";
    const extra = ["__proto__", "constructor", "toString"].includes(kind)
      ? `${kind}: synthetic\r\n`
      : "";
    try {
      const response = await app.inject({
        method: "POST",
        url: "/",
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload: `--${boundary}\r\n${extra}Content-Disposition: form-data; name="model"\r\n\r\nalias\r\n--${boundary}--\r\n${kind === "epilogue" ? "synthetic epilogue" : ""}`,
      });
      expect(response.statusCode).toBe(
        kind === "oversized-boundary" ? 400 : 200,
      );
      if (kind !== "oversized-boundary")
        expect(response.json()).toEqual({ model: "alias" });
    } finally {
      await app.close();
    }
  }, 2000);
  test("accepts the exact per-file bound", async () => {
    const form = new FormData();
    form.append("file", new File([bytes], "input.wav"));
    expect(
      (await upload(form, { maxFileBytes: bytes.length })).statusCode,
    ).toBe(200);
  });
  test("preserves arbitrary bytes, ordered SDK arrays and safe basename metadata", async () => {
    const form = new FormData();
    form.append("model", "alias");
    form.append("include[]", "first");
    form.append("include[]", "second");
    form.append(
      "image[]",
      new File([bytes], "../one.png", { type: "image/png" }),
    );
    form.append(
      "image[]",
      new File([new Uint8Array([2])], "two.png", { type: "image/png" }),
    );
    const response = await upload(form);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      fields: { model: "alias", include: ["first", "second"] },
      files: [
        {
          fieldname: "image",
          filename: "one.png",
          size: bytes.length,
          hash: createHash("sha256").update(bytes).digest("hex"),
        },
        { filename: "two.png", size: 1 },
      ],
    });
  });
  test.each([
    "model",
    "mask",
  ])("rejects duplicate scalar %s parts", async (field) => {
    const form = new FormData();
    for (let i = 0; i < 2; i++) {
      if (field === "model") form.append(field, "alias");
      else form.append(field, new File([bytes], "mask.png"));
    }
    expect((await upload(form)).statusCode).toBe(400);
  });
  test.each([
    "file",
    "aggregate",
    "field",
    "wire",
    "count",
  ])("enforces %s limits", async (kind) => {
    const form = new FormData();
    form.append("file", new File([bytes], "input.wav"));
    if (kind === "aggregate")
      form.append("image[]", new File([bytes], "two.png"));
    if (kind === "field") form.append("prompt", "x".repeat(33));
    if (kind === "count")
      for (let i = 0; i < 5; i++) form.append(`field${i}`, "x");
    const response = await upload(form, {
      maxFileBytes: kind === "file" ? 7 : 64,
      maxTotalFileBytes: kind === "aggregate" ? 15 : 128,
      bodyLimit: kind === "wire" ? 100 : 8192,
    });
    expect(response.statusCode, response.body).toBe(413);
  });
  test("rejects unexpected files and non-array bracket syntax", async () => {
    const form = new FormData();
    form.append("file[]", new File([bytes], "input.wav"));
    expect((await upload(form)).statusCode).toBe(400);
    const unknown = new FormData();
    unknown.append("unknown", new File([bytes], "input.wav"));
    expect((await upload(unknown)).statusCode).toBe(400);
  });
  test("rejects malformed/truncated boundaries without leaking body text", async () => {
    const app = Fastify();
    await registerMediaMultipartParser(app);
    app.post("/", (request) =>
      parseMediaMultipart(request, {
        fileFields: ["file"],
        maxFiles: 1,
        maxFileBytes: 64,
        maxTotalFileBytes: 64,
      }),
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: "/",
        headers: { "content-type": "multipart/form-data; boundary=broken" },
        payload:
          '--broken\r\nContent-Disposition: form-data; name="file"; filename="input.wav"\r\n\r\nPRIVATE_AUDIO_BYTES',
      });
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain("PRIVATE_AUDIO_BYTES");
    } finally {
      await app.close();
    }
  });
});

test("real chunked uploads preserve every byte and enforce aggregate limits without consuming the raw stream twice", async () => {
  const app = Fastify({ bodyLimit: 1024 });
  await registerMediaMultipartParser(app);
  app.post("/", async (request) => {
    expect(request.body).toBeUndefined();
    const parsed = await parseMediaMultipart(request, {
      fileFields: ["file"],
      maxFiles: 1,
      maxFileBytes: 64,
      maxTotalFileBytes: 64,
    });
    return {
      hash: createHash("sha256").update(parsed.files[0].data).digest("hex"),
    };
  });
  const origin = await app.listen({ port: 0, host: "127.0.0.1" });
  const form = new FormData();
  form.append("file", new File([bytes], "input.wav"));
  const wire = new Request(origin, { method: "POST", body: form });
  const raw = Buffer.from(await wire.arrayBuffer());
  const type = wire.headers.get("content-type") ?? "";
  try {
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        sendChunked({ origin, type, bytes: raw }),
      ),
    );
    for (const response of results) {
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body).hash).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
    }
    expect(
      (await sendChunked({ origin, type, bytes: Buffer.alloc(1025) })).status,
    ).toBe(413);
  } finally {
    await app.close();
  }
});

test("upload deadline and disconnect release the request before the next upload", async () => {
  const app = Fastify({ bodyLimit: 1024 });
  await registerMediaMultipartParser(app, { uploadTimeoutMs: 30 });
  app.post("/", async (request) => {
    const parsed = await parseMediaMultipart(request, {
      fileFields: ["file"],
      maxFiles: 1,
      maxFileBytes: 64,
      maxTotalFileBytes: 64,
    });
    return { files: parsed.files.length };
  });
  const origin = await app.listen({ port: 0, host: "127.0.0.1" });
  const form = new FormData();
  form.append("file", new File([bytes], "input.wav"));
  const wire = new Request(origin, { method: "POST", body: form });
  const raw = Buffer.from(await wire.arrayBuffer());
  const type = wire.headers.get("content-type") ?? "";
  try {
    expect(
      (
        await sendChunked({
          origin,
          type,
          bytes: raw.subarray(0, 30),
          unfinished: true,
        })
      ).status,
    ).toBe(408);
    await new Promise<void>((resolve) => {
      const aborted = httpRequest(origin, {
        method: "POST",
        headers: { "content-type": type, "transfer-encoding": "chunked" },
      });
      aborted.on("error", () => {});
      aborted.on("close", resolve);
      aborted.write(raw.subarray(0, 30));
      aborted.destroy();
    });
    expect((await sendChunked({ origin, type, bytes: raw })).status).toBe(200);
  } finally {
    await app.close();
  }
});

function sendChunked(params: {
  origin: string;
  type: string;
  bytes: Buffer;
  unfinished?: boolean;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const client = httpRequest(
      params.origin,
      {
        method: "POST",
        headers: {
          "content-type": params.type,
          "transfer-encoding": "chunked",
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
          });
          client.destroy();
        });
      },
    );
    client.on("error", reject);
    for (let offset = 0; offset < params.bytes.length; offset += 7)
      client.write(params.bytes.subarray(offset, offset + 7));
    if (!params.unfinished) client.end();
  });
}
