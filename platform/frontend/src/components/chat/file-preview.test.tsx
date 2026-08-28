// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { FilePreview } from "@/components/chat/file-preview";
import {
  LOCKED_CHAT_KEY_HEADER,
  storeLockedChatKey,
} from "@/lib/chat/locked-chat";

const API_ORIGIN = "http://localhost:9000";
const ARTIFACT_URL = `${API_ORIGIN}/api/skill-sandbox/artifacts/svg-1`;
const SEALED_URL = "/api/chat/attachments/att-1/content";
const CONVERSATION_ID = "conv-1";
const LOCKED_CHAT_KEY = "a".repeat(43);
const SVG_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

// A non-ASCII character pins that the bytes reach the data URL untouched
// rather than round-tripping through a text decode.
const SVG_BYTES = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><title>café</title></svg>',
);

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));

afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

afterAll(() => server.close());

/** The byte route serves SVG download-only; the preview must cope with that. */
function serveArtifact(body: Uint8Array) {
  server.use(
    http.get(
      ARTIFACT_URL,
      () =>
        new HttpResponse(body, {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": 'attachment; filename="chart.svg"',
          },
        }),
    ),
  );
}

/** Decoded bytes as a plain array: jsdom and node typed arrays are different realms. */
function decodeDataUrl(src: string): number[] {
  const [header, payload] = src.split(",");
  expect(header).toBe("data:image/svg+xml;base64");
  return Array.from(atob(payload), (c) => c.charCodeAt(0));
}

/**
 * jsdom implements neither `URL.createObjectURL` nor a `blob:`-capable fetch,
 * so the locked-chat path runs against a hand-rolled fetch: the sealed route
 * answers with a Blob, the resulting `blob:` URL answers with bytes.
 */
function stubLockedChatFetch(blobBytes: Uint8Array) {
  const fetchSpy = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url === SEALED_URL) {
      return {
        ok: true,
        headers: new Headers(),
        blob: async () => new Blob([SVG_BYTES]),
      };
    }
    if (url === "blob:sealed") {
      // A real blob: fetch reports its length; the cap is enforced from it.
      return {
        ok: true,
        headers: new Headers({ "Content-Length": String(blobBytes.length) }),
        arrayBuffer: async () => blobBytes.buffer.slice(0),
      };
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchSpy);
  URL.createObjectURL = vi.fn(() => "blob:sealed");
  URL.revokeObjectURL = vi.fn();
  storeLockedChatKey(CONVERSATION_ID, LOCKED_CHAT_KEY);
  return fetchSpy;
}

describe("FilePreview svg", () => {
  it("renders the served bytes as an image/svg+xml data URL", async () => {
    serveArtifact(SVG_BYTES);

    render(
      <FilePreview
        file={{
          name: "chart.svg",
          mimeType: "image/svg+xml",
          contentUrl: ARTIFACT_URL,
        }}
      />,
    );

    const img = await screen.findByRole<HTMLImageElement>("img", {
      name: "chart.svg",
    });
    expect(decodeDataUrl(img.src)).toEqual(Array.from(SVG_BYTES));
  });

  it("falls back to download above the size cap", async () => {
    serveArtifact(new Uint8Array(SVG_PREVIEW_MAX_BYTES + 1));

    render(
      <FilePreview
        file={{
          name: "huge.svg",
          mimeType: "image/svg+xml",
          contentUrl: ARTIFACT_URL,
        }}
      />,
    );

    const link = await screen.findByRole<HTMLAnchorElement>("link", {
      name: /download/i,
    });
    expect(link.href).toBe(ARTIFACT_URL);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("refuses an oversize file on its length header, without reading the body", async () => {
    const arrayBuffer = vi.fn(async () => {
      throw new Error("body must not be read");
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        headers: new Headers({
          "Content-Length": String(SVG_PREVIEW_MAX_BYTES + 1),
        }),
        arrayBuffer,
      })),
    );

    render(
      <FilePreview
        file={{
          name: "huge.svg",
          mimeType: "image/svg+xml",
          contentUrl: ARTIFACT_URL,
        }}
      />,
    );

    await screen.findByRole("link", { name: /download/i });
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("in a locked chat, reads the sealed bytes once with the key and converts the blob", async () => {
    const fetchSpy = stubLockedChatFetch(SVG_BYTES);

    render(
      <FilePreview
        file={{
          name: "sealed.svg",
          mimeType: "image/svg+xml",
          contentUrl: SEALED_URL,
        }}
        conversationId={CONVERSATION_ID}
      />,
    );

    const img = await screen.findByRole<HTMLImageElement>("img", {
      name: "sealed.svg",
    });
    expect(decodeDataUrl(img.src)).toEqual(Array.from(SVG_BYTES));

    const sealedCalls = fetchSpy.mock.calls.filter(
      ([url]) => url === SEALED_URL,
    );
    expect(sealedCalls).toHaveLength(1);
    expect(sealedCalls[0]?.[1]).toEqual({
      headers: { [LOCKED_CHAT_KEY_HEADER]: LOCKED_CHAT_KEY },
    });
  });

  it("in a locked chat, the size-cap fallback downloads the resolved blob", async () => {
    stubLockedChatFetch(new Uint8Array(SVG_PREVIEW_MAX_BYTES + 1));

    render(
      <FilePreview
        file={{
          name: "sealed-huge.svg",
          mimeType: "image/svg+xml",
          contentUrl: SEALED_URL,
        }}
        conversationId={CONVERSATION_ID}
      />,
    );

    const link = await screen.findByRole<HTMLAnchorElement>("link", {
      name: /download/i,
    });
    expect(link.getAttribute("href")).toBe("blob:sealed");
    expect(screen.queryByRole("img")).toBeNull();
  });
});
