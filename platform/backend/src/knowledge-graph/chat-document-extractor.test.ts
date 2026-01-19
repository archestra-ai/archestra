import { vi } from "vitest";
import { beforeEach, describe, expect, test } from "@/test";

import { MAX_DOCUMENT_SIZE_BYTES } from "./constants";

// Mock the knowledge graph index module
vi.mock("./index", () => ({
  isKnowledgeGraphEnabled: vi.fn().mockReturnValue(false),
  ingestDocument: vi.fn().mockResolvedValue(true),
}));

import { extractAndIngestDocuments } from "./chat-document-extractor";
import { ingestDocument, isKnowledgeGraphEnabled } from "./index";

describe("extractAndIngestDocuments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("returns early when knowledge graph is not enabled", async () => {
    vi.mocked(isKnowledgeGraphEnabled).mockReturnValue(false);

    await extractAndIngestDocuments([
      {
        role: "user",
        parts: [
          {
            type: "file",
            url: "data:text/plain;base64,SGVsbG8gV29ybGQ=",
            mediaType: "text/plain",
            filename: "test.txt",
          },
        ],
      },
    ]);

    expect(ingestDocument).not.toHaveBeenCalled();
  });

  test("returns early when no messages provided", async () => {
    vi.mocked(isKnowledgeGraphEnabled).mockReturnValue(true);

    await extractAndIngestDocuments([]);

    expect(ingestDocument).not.toHaveBeenCalled();
  });

  test("returns early when no user messages", async () => {
    vi.mocked(isKnowledgeGraphEnabled).mockReturnValue(true);

    await extractAndIngestDocuments([
      {
        role: "assistant",
        parts: [
          {
            type: "file",
            url: "data:text/plain;base64,SGVsbG8gV29ybGQ=",
            mediaType: "text/plain",
            filename: "test.txt",
          },
        ],
      },
    ]);

    expect(ingestDocument).not.toHaveBeenCalled();
  });

  test("extracts and ingests text file from data URL", async () => {
    vi.mocked(isKnowledgeGraphEnabled).mockReturnValue(true);

    const base64Content = Buffer.from("Hello World").toString("base64");

    await extractAndIngestDocuments([
      {
        role: "user",
        parts: [
          {
            type: "file",
            url: `data:text/plain;base64,${base64Content}`,
            mediaType: "text/plain",
            filename: "test.txt",
          },
        ],
      },
    ]);

    expect(ingestDocument).toHaveBeenCalledWith({
      content: "Hello World",
      filename: "test.txt",
    });
  });

  test("extracts markdown file based on extension", async () => {
    vi.mocked(isKnowledgeGraphEnabled).mockReturnValue(true);

    const content = "# Title\n\nSome content";
    const base64Content = Buffer.from(content).toString("base64");

    await extractAndIngestDocuments([
      {
        role: "user",
        parts: [
          {
            type: "file",
            url: `data:application/octet-stream;base64,${base64Content}`,
            mediaType: "application/octet-stream", // Generic type
            filename: "document.md",
          },
        ],
      },
    ]);

    expect(ingestDocument).toHaveBeenCalledWith({
      content: content,
      filename: "document.md",
    });
  });

  test("extracts JSON file", async () => {
    vi.mocked(isKnowledgeGraphEnabled).mockReturnValue(true);

    const content = '{"key": "value"}';
    const base64Content = Buffer.from(content).toString("base64");

    await extractAndIngestDocuments([
      {
        role: "user",
        parts: [
          {
            type: "file",
            url: `data:application/json;base64,${base64Content}`,
            mediaType: "application/json",
            filename: "data.json",
          },
        ],
      },
    ]);

    expect(ingestDocument).toHaveBeenCalledWith({
      content: content,
      filename: "data.json",
    });
  });

  test("extracts CSV file", async () => {
    vi.mocked(isKnowledgeGraphEnabled).mockReturnValue(true);

    const content = "name,age\nJohn,30\nJane,25";
    const base64Content = Buffer.from(content).toString("base64");

    await extractAndIngestDocuments([
      {
        role: "user",
        parts: [
          {
            type: "file",
            url: `data:text/csv;base64,${base64Content}`,
            mediaType: "text/csv",
            filename: "data.csv",
          },
        ],
      },
    ]);

    expect(ingestDocument).toHaveBeenCalledWith({
      content: content,
      filename: "data.csv",
    });
  });

  test("extracts TypeScript file based on extension", async () => {
    vi.mocked(isKnowledgeGraphEnabled).mockReturnValue(true);

    const content = 'const x: string = "hello";';
    const base64Content = Buffer.from(content).toString("base64");

    await extractAndIngestDocuments([
      {
        role: "user",
        parts: [
          {
            type: "file",
            url: `data:application/octet-stream;base64,${base64Content}`,
            mediaType: "application/octet-stream",
            filename: "code.ts",
          },
        ],
      },
    ]);

    expect(ingestDocument).toHaveBeenCalledWith({
      content: content,
      filename: "code.ts",
    });
  });

  test("extracts Python file based on extension", async () => {
    vi.mocked(isKnowledgeGraphEnabled).mockReturnValue(true);

    const content = 'print("Hello World")';
    const base64Content = Buffer.from(content).toString("base64");

    await extractAndIngestDocuments([
      {
        role: "user",
        parts: [
          {
            type: "file",
            url: `data:application/octet-stream;base64,${base64Content}`,
            mediaType: "application/octet-stream",
            filename: "script.py",
          },
        ],
      },
    ]);

    expect(ingestDocument).toHaveBeenCalledWith({
      content: content,
      filename: "script.py",
    });
  });

  test("skips unsupported file types (images)", async () => {
    vi.mocked(isKnowledgeGraphEnabled).mockReturnValue(true);

    const base64Content = Buffer.from("fake image data").toString("base64");

    await extractAndIngestDocuments([
      {
        role: "user",
        parts: [
          {
            type: "file",
            url: `data:image/png;base64,${base64Content}`,
            mediaType: "image/png",
            filename: "photo.png",
          },
        ],
      },
    ]);

    expect(ingestDocument).not.toHaveBeenCalled();
  });

  test("skips unsupported file types (PDF)", async () => {
    vi.mocked(isKnowledgeGraphEnabled).mockReturnValue(true);

    const base64Content = Buffer.from("fake pdf data").toString("base64");

    await extractAndIngestDocuments([
      {
        role: "user",
        parts: [
          {
            type: "file",
            url: `data:application/pdf;base64,${base64Content}`,
            mediaType: "application/pdf",
            filename: "document.pdf",
          },
        ],
      },
    ]);

    expect(ingestDocument).not.toHaveBeenCalled();
  });

  test("skips non-file message parts", async () => {
    vi.mocked(isKnowledgeGraphEnabled).mockReturnValue(true);

    await extractAndIngestDocuments([
      {
        role: "user",
        parts: [
          {
            type: "text",
            text: "Hello world",
          },
        ],
      },
    ]);

    expect(ingestDocument).not.toHaveBeenCalled();
  });

  test("extracts from 'data' field when URL is not present", async () => {
    vi.mocked(isKnowledgeGraphEnabled).mockReturnValue(true);

    const content = "Content from data field";
    const base64Content = Buffer.from(content).toString("base64");

    await extractAndIngestDocuments([
      {
        role: "user",
        parts: [
          {
            type: "file",
            data: base64Content,
            mediaType: "text/plain",
            filename: "test.txt",
          },
        ],
      },
    ]);

    expect(ingestDocument).toHaveBeenCalledWith({
      content: content,
      filename: "test.txt",
    });
  });

  test("extracts from 'content' array when parts is empty", async () => {
    vi.mocked(isKnowledgeGraphEnabled).mockReturnValue(true);

    const content = "Content from content array";
    const base64Content = Buffer.from(content).toString("base64");

    await extractAndIngestDocuments([
      {
        role: "user",
        parts: [],
        content: [
          {
            type: "file",
            url: `data:text/plain;base64,${base64Content}`,
            mediaType: "text/plain",
            filename: "test.txt",
          },
        ],
      },
    ]);

    expect(ingestDocument).toHaveBeenCalledWith({
      content: content,
      filename: "test.txt",
    });
  });

  test("ingests multiple documents from a single message", async () => {
    vi.mocked(isKnowledgeGraphEnabled).mockReturnValue(true);

    const content1 = "First document";
    const content2 = "Second document";
    const base64Content1 = Buffer.from(content1).toString("base64");
    const base64Content2 = Buffer.from(content2).toString("base64");

    await extractAndIngestDocuments([
      {
        role: "user",
        parts: [
          {
            type: "file",
            url: `data:text/plain;base64,${base64Content1}`,
            mediaType: "text/plain",
            filename: "first.txt",
          },
          {
            type: "file",
            url: `data:text/plain;base64,${base64Content2}`,
            mediaType: "text/plain",
            filename: "second.txt",
          },
        ],
      },
    ]);

    expect(ingestDocument).toHaveBeenCalledTimes(2);
    expect(ingestDocument).toHaveBeenCalledWith({
      content: content1,
      filename: "first.txt",
    });
    expect(ingestDocument).toHaveBeenCalledWith({
      content: content2,
      filename: "second.txt",
    });
  });

  test("ingests documents from multiple user messages", async () => {
    vi.mocked(isKnowledgeGraphEnabled).mockReturnValue(true);

    const content1 = "Document from first message";
    const content2 = "Document from second message";
    const base64Content1 = Buffer.from(content1).toString("base64");
    const base64Content2 = Buffer.from(content2).toString("base64");

    await extractAndIngestDocuments([
      {
        role: "user",
        parts: [
          {
            type: "file",
            url: `data:text/plain;base64,${base64Content1}`,
            mediaType: "text/plain",
            filename: "first.txt",
          },
        ],
      },
      {
        role: "assistant",
        parts: [{ type: "text", text: "I received your file" }],
      },
      {
        role: "user",
        parts: [
          {
            type: "file",
            url: `data:text/plain;base64,${base64Content2}`,
            mediaType: "text/plain",
            filename: "second.txt",
          },
        ],
      },
    ]);

    expect(ingestDocument).toHaveBeenCalledTimes(2);
  });

  test("uses 'unknown' as filename when not provided", async () => {
    vi.mocked(isKnowledgeGraphEnabled).mockReturnValue(true);

    const content = "Content without filename";
    const base64Content = Buffer.from(content).toString("base64");

    await extractAndIngestDocuments([
      {
        role: "user",
        parts: [
          {
            type: "file",
            url: `data:text/plain;base64,${base64Content}`,
            mediaType: "text/plain",
            // No filename
          },
        ],
      },
    ]);

    expect(ingestDocument).toHaveBeenCalledWith({
      content: content,
      filename: "unknown",
    });
  });

  test("handles ingestion errors gracefully", async () => {
    vi.mocked(isKnowledgeGraphEnabled).mockReturnValue(true);
    vi.mocked(ingestDocument).mockRejectedValueOnce(
      new Error("Ingestion failed"),
    );

    const content = "Test content";
    const base64Content = Buffer.from(content).toString("base64");

    // Should not throw
    await expect(
      extractAndIngestDocuments([
        {
          role: "user",
          parts: [
            {
              type: "file",
              url: `data:text/plain;base64,${base64Content}`,
              mediaType: "text/plain",
              filename: "test.txt",
            },
          ],
        },
      ]),
    ).resolves.not.toThrow();

    expect(ingestDocument).toHaveBeenCalled();
  });

  test("handles malformed data URLs gracefully", async () => {
    vi.mocked(isKnowledgeGraphEnabled).mockReturnValue(true);

    await extractAndIngestDocuments([
      {
        role: "user",
        parts: [
          {
            type: "file",
            url: "not-a-valid-data-url",
            mediaType: "text/plain",
            filename: "test.txt",
          },
        ],
      },
    ]);

    expect(ingestDocument).not.toHaveBeenCalled();
  });

  test("handles invalid base64 in data URL gracefully", async () => {
    vi.mocked(isKnowledgeGraphEnabled).mockReturnValue(true);

    await extractAndIngestDocuments([
      {
        role: "user",
        parts: [
          {
            type: "file",
            url: "data:text/plain;base64,!!!invalid-base64!!!",
            mediaType: "text/plain",
            filename: "test.txt",
          },
        ],
      },
    ]);

    // The function handles invalid base64 gracefully - it may or may not call ingestDocument
    // depending on how Buffer.from handles the invalid input
    // The key is that it should not throw
  });

  test("extracts SQL files", async () => {
    vi.mocked(isKnowledgeGraphEnabled).mockReturnValue(true);

    const content = "SELECT * FROM users WHERE id = 1;";
    const base64Content = Buffer.from(content).toString("base64");

    await extractAndIngestDocuments([
      {
        role: "user",
        parts: [
          {
            type: "file",
            url: `data:application/octet-stream;base64,${base64Content}`,
            mediaType: "application/octet-stream",
            filename: "query.sql",
          },
        ],
      },
    ]);

    expect(ingestDocument).toHaveBeenCalledWith({
      content: content,
      filename: "query.sql",
    });
  });

  test("extracts YAML files", async () => {
    vi.mocked(isKnowledgeGraphEnabled).mockReturnValue(true);

    const content = "key: value\nlist:\n  - item1\n  - item2";
    const base64Content = Buffer.from(content).toString("base64");

    await extractAndIngestDocuments([
      {
        role: "user",
        parts: [
          {
            type: "file",
            url: `data:text/yaml;base64,${base64Content}`,
            mediaType: "text/yaml",
            filename: "config.yml",
          },
        ],
      },
    ]);

    expect(ingestDocument).toHaveBeenCalledWith({
      content: content,
      filename: "config.yml",
    });
  });

  test("extracts HTML files", async () => {
    vi.mocked(isKnowledgeGraphEnabled).mockReturnValue(true);

    const content = "<html><body><h1>Hello</h1></body></html>";
    const base64Content = Buffer.from(content).toString("base64");

    await extractAndIngestDocuments([
      {
        role: "user",
        parts: [
          {
            type: "file",
            url: `data:text/html;base64,${base64Content}`,
            mediaType: "text/html",
            filename: "page.html",
          },
        ],
      },
    ]);

    expect(ingestDocument).toHaveBeenCalledWith({
      content: content,
      filename: "page.html",
    });
  });

  test("extracts shell script files", async () => {
    vi.mocked(isKnowledgeGraphEnabled).mockReturnValue(true);

    const content = "#!/bin/bash\necho 'Hello World'";
    const base64Content = Buffer.from(content).toString("base64");

    await extractAndIngestDocuments([
      {
        role: "user",
        parts: [
          {
            type: "file",
            url: `data:application/octet-stream;base64,${base64Content}`,
            mediaType: "application/octet-stream",
            filename: "script.sh",
          },
        ],
      },
    ]);

    expect(ingestDocument).toHaveBeenCalledWith({
      content: content,
      filename: "script.sh",
    });
  });

  test("extracts Go files", async () => {
    vi.mocked(isKnowledgeGraphEnabled).mockReturnValue(true);

    const content =
      'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println("Hello") }';
    const base64Content = Buffer.from(content).toString("base64");

    await extractAndIngestDocuments([
      {
        role: "user",
        parts: [
          {
            type: "file",
            url: `data:application/octet-stream;base64,${base64Content}`,
            mediaType: "application/octet-stream",
            filename: "main.go",
          },
        ],
      },
    ]);

    expect(ingestDocument).toHaveBeenCalledWith({
      content: content,
      filename: "main.go",
    });
  });

  test("extracts Rust files", async () => {
    vi.mocked(isKnowledgeGraphEnabled).mockReturnValue(true);

    const content = 'fn main() { println!("Hello, world!"); }';
    const base64Content = Buffer.from(content).toString("base64");

    await extractAndIngestDocuments([
      {
        role: "user",
        parts: [
          {
            type: "file",
            url: `data:application/octet-stream;base64,${base64Content}`,
            mediaType: "application/octet-stream",
            filename: "main.rs",
          },
        ],
      },
    ]);

    expect(ingestDocument).toHaveBeenCalledWith({
      content: content,
      filename: "main.rs",
    });
  });

  test("skips documents exceeding MAX_DOCUMENT_SIZE_BYTES limit", async () => {
    vi.mocked(isKnowledgeGraphEnabled).mockReturnValue(true);

    // Create a content that exceeds the size limit (10MB + 1 byte)
    const oversizedContent = "x".repeat(MAX_DOCUMENT_SIZE_BYTES + 1);
    const base64Content = Buffer.from(oversizedContent).toString("base64");

    await extractAndIngestDocuments([
      {
        role: "user",
        parts: [
          {
            type: "file",
            url: `data:text/plain;base64,${base64Content}`,
            mediaType: "text/plain",
            filename: "large-file.txt",
          },
        ],
      },
    ]);

    // Should not ingest because document exceeds size limit
    expect(ingestDocument).not.toHaveBeenCalled();
  });

  test("skips documents when estimated base64 size exceeds limit", async () => {
    vi.mocked(isKnowledgeGraphEnabled).mockReturnValue(true);

    // Create base64 content where the estimated decoded size would exceed the limit
    // Base64 adds ~33% overhead, so create content that when base64 encoded,
    // its estimated decoded size (length * 0.75) exceeds MAX_DOCUMENT_SIZE_BYTES
    // To ensure estimated size > 10MB, we need base64Length * 0.75 > 10MB
    // So base64Length > 10MB / 0.75 = ~13.33MB
    // This will be caught by the early size check before decoding
    const largeBase64 = "A".repeat(
      Math.ceil(MAX_DOCUMENT_SIZE_BYTES / 0.75) + 1000,
    );

    await extractAndIngestDocuments([
      {
        role: "user",
        parts: [
          {
            type: "file",
            url: `data:text/plain;base64,${largeBase64}`,
            mediaType: "text/plain",
            filename: "estimated-large-file.txt",
          },
        ],
      },
    ]);

    // Should not ingest because estimated size exceeds limit
    expect(ingestDocument).not.toHaveBeenCalled();
  });

  test("ingests documents just under the size limit", async () => {
    vi.mocked(isKnowledgeGraphEnabled).mockReturnValue(true);

    // Create a document that's just under the size limit (1KB under to be safe)
    const justUnderLimitContent = "x".repeat(MAX_DOCUMENT_SIZE_BYTES - 1024);
    const base64Content = Buffer.from(justUnderLimitContent).toString("base64");

    await extractAndIngestDocuments([
      {
        role: "user",
        parts: [
          {
            type: "file",
            url: `data:text/plain;base64,${base64Content}`,
            mediaType: "text/plain",
            filename: "acceptable-size.txt",
          },
        ],
      },
    ]);

    // Should ingest because document is under size limit
    expect(ingestDocument).toHaveBeenCalledWith({
      content: justUnderLimitContent,
      filename: "acceptable-size.txt",
    });
  });

  test("skips files with invalid UTF-8 content (binary data)", async () => {
    vi.mocked(isKnowledgeGraphEnabled).mockReturnValue(true);

    // Create binary data that will produce replacement characters when decoded as UTF-8
    // These are invalid UTF-8 byte sequences
    const binaryData = Buffer.from([0x80, 0x81, 0x82, 0xff, 0xfe]);
    const base64Content = binaryData.toString("base64");

    await extractAndIngestDocuments([
      {
        role: "user",
        parts: [
          {
            type: "file",
            url: `data:text/plain;base64,${base64Content}`,
            mediaType: "text/plain",
            filename: "binary-file.txt",
          },
        ],
      },
    ]);

    // Should not ingest because content contains invalid UTF-8
    expect(ingestDocument).not.toHaveBeenCalled();
  });

  test("skips files with invalid UTF-8 in data field", async () => {
    vi.mocked(isKnowledgeGraphEnabled).mockReturnValue(true);

    // Create binary data that will produce replacement characters when decoded as UTF-8
    const binaryData = Buffer.from([0x80, 0x81, 0x82, 0xff, 0xfe]);
    const base64Content = binaryData.toString("base64");

    await extractAndIngestDocuments([
      {
        role: "user",
        parts: [
          {
            type: "file",
            data: base64Content,
            mediaType: "text/plain",
            filename: "binary-file.txt",
          },
        ],
      },
    ]);

    // Should not ingest because content contains invalid UTF-8
    expect(ingestDocument).not.toHaveBeenCalled();
  });

  test("ingests valid UTF-8 content with special characters", async () => {
    vi.mocked(isKnowledgeGraphEnabled).mockReturnValue(true);

    // Content with valid UTF-8 including emoji and international characters
    const validUtf8Content = "Hello 世界! 🎉 Ñoño café";
    const base64Content = Buffer.from(validUtf8Content).toString("base64");

    await extractAndIngestDocuments([
      {
        role: "user",
        parts: [
          {
            type: "file",
            url: `data:text/plain;base64,${base64Content}`,
            mediaType: "text/plain",
            filename: "utf8-file.txt",
          },
        ],
      },
    ]);

    // Should ingest because content is valid UTF-8
    expect(ingestDocument).toHaveBeenCalledWith({
      content: validUtf8Content,
      filename: "utf8-file.txt",
    });
  });
});
