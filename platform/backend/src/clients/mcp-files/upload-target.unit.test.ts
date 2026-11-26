import { describe, expect, test } from "vitest";
import {
  multipartFileContentType,
  parseUploadRequiredResult,
  resolveUploadTargetUrl,
  UploadTargetError,
  validateUploadTarget,
} from "./upload-target";

const options = { allowHttpLoopback: false };
const urlTarget = (overrides: Record<string, unknown> = {}) => ({
  fileId: "f1",
  url: "https://storage.example.com/u/1?sig=abc",
  credentials: "omit",
  ...overrides,
});

describe("validateUploadTarget", () => {
  test("accepts a conforming target and treats null members as absent", () => {
    expect(
      validateUploadTarget(
        urlTarget({
          path: null,
          headers: { "Content-Type": "application/pdf" },
        }),
        options,
      ),
    ).toEqual({
      fileId: "f1",
      url: "https://storage.example.com/u/1?sig=abc",
      headers: { "Content-Type": "application/pdf" },
      credentials: "omit",
    });
  });

  test.each([
    ["both url and path", urlTarget({ path: "/u" })],
    ["neither url nor path", { fileId: "f1", credentials: "omit" }],
    ["an unknown member", urlTarget({ extra: 1 })],
    ["no credentials mode", urlTarget({ credentials: "same-origin" })],
    ["an http url", urlTarget({ url: "http://storage.example.com/u" })],
    [
      "userinfo in the url",
      urlTarget({ url: "https://a:b@storage.example.com/u" }),
    ],
    ["a dot segment", { fileId: "f1", path: "/a/../b", credentials: "omit" }],
    [
      "a path character outside the set",
      { fileId: "f1", path: "/a b", credentials: "omit" },
    ],
    ["an Authorization header", urlTarget({ headers: { Authorization: "x" } })],
    ["a Cookie header", urlTarget({ headers: { cookie: "x" } })],
    ["a forbidden header", urlTarget({ headers: { Host: "evil" } })],
    ["a sec- header", urlTarget({ headers: { "Sec-Fetch-Mode": "cors" } })],
    [
      "a header value with a newline",
      urlTarget({ headers: { "X-A": "a\nb" } }),
    ],
    [
      "a rerouting header on a path target",
      {
        fileId: "f1",
        path: "/u",
        credentials: "omit",
        headers: { "X-Forwarded-Host": "e" },
      },
    ],
    ["an invalid expiresAt", urlTarget({ expiresAt: "tomorrow" })],
    [
      "a form without POST",
      urlTarget({ form: { fields: [], fileField: "file" } }),
    ],
    [
      "a form with a Content-Type header",
      urlTarget({
        method: "POST",
        headers: { "Content-Type": "x" },
        form: { fields: [], fileField: "file" },
      }),
    ],
    [
      "a form field named like the file field",
      urlTarget({
        method: "POST",
        form: { fields: [{ name: "file", value: "v" }], fileField: "file" },
      }),
    ],
    [
      "a form field name with a quote",
      urlTarget({
        method: "POST",
        form: { fields: [{ name: 'a"b', value: "v" }], fileField: "file" },
      }),
    ],
  ])("refuses %s", (_label, raw) => {
    expect(() => validateUploadTarget(raw, options)).toThrow(UploadTargetError);
  });

  test("allows a loopback http url only when the operator allows it", () => {
    const raw = urlTarget({ url: "http://127.0.0.1:9000/u" });
    expect(() => validateUploadTarget(raw, options)).toThrow(UploadTargetError);
    expect(validateUploadTarget(raw, { allowHttpLoopback: true }).url).toBe(
      "http://127.0.0.1:9000/u",
    );
    expect(() =>
      validateUploadTarget(urlTarget({ url: "http://10.0.0.1/u" }), {
        allowHttpLoopback: true,
      }),
    ).toThrow(UploadTargetError);
  });
});

describe("parseUploadRequiredResult", () => {
  test("requires exactly one target per data-less file and nothing else", () => {
    const result = (uploads: unknown[]) => ({
      resultType: "upload_required",
      uploads,
      requestState: "s",
    });
    expect(
      parseUploadRequiredResult(result([urlTarget()]), ["f1"], options).uploads,
    ).toHaveLength(1);
    expect(() =>
      parseUploadRequiredResult(result([urlTarget()]), ["f1", "f2"], options),
    ).toThrow(/no target for "f2"/);
    expect(() =>
      parseUploadRequiredResult(
        result([urlTarget({ fileId: "f9" })]),
        ["f1"],
        options,
      ),
    ).toThrow(/"f9"/);
    expect(() =>
      parseUploadRequiredResult(
        result([urlTarget(), urlTarget()]),
        ["f1"],
        options,
      ),
    ).toThrow(/two targets/);
    expect(() =>
      parseUploadRequiredResult(
        { resultType: "upload_required", uploads: [urlTarget()] },
        ["f1"],
        options,
      ),
    ).toThrow(/requestState/);
  });
});

describe("resolveUploadTargetUrl", () => {
  const mcp = new URL("https://gateway.example.com/mcp/abc/?tenant=1");

  test("appends a path to the MCP address and keeps its query", () => {
    expect(
      resolveUploadTargetUrl(
        { fileId: "f1", path: "/uploads/1", credentials: "include" },
        new URL("https://gateway.example.com/mcp/abc?tenant=1"),
      ).href,
    ).toBe("https://gateway.example.com/mcp/abc/uploads/1?tenant=1");
    expect(
      resolveUploadTargetUrl(
        { fileId: "f1", path: "/uploads/1", credentials: "omit" },
        mcp,
      ).href,
    ).toBe("https://gateway.example.com/mcp/abc/uploads/1?tenant=1");
  });

  test("an include url must stay on the server's origin", () => {
    expect(() =>
      resolveUploadTargetUrl(
        {
          fileId: "f1",
          url: "https://elsewhere.example.com/u",
          credentials: "include",
        },
        mcp,
      ),
    ).toThrow(/another origin/);
    expect(
      resolveUploadTargetUrl(
        {
          fileId: "f1",
          url: "https://gateway.example.com/u",
          credentials: "include",
        },
        mcp,
      ).href,
    ).toBe("https://gateway.example.com/u");
  });
});

describe("helpers", () => {
  test("a multipart file part falls back to octet-stream for an invalid type", () => {
    expect(multipartFileContentType("application/pdf")).toBe("application/pdf");
    expect(multipartFileContentType("not a type")).toBe(
      "application/octet-stream",
    );
  });
});
