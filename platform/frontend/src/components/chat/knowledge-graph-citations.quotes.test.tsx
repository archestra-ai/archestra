import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { KnowledgeGraphCitations } from "./knowledge-graph-citations";

const DOC = "178ee2de-983e-4500-97ae-6c40e913ed24";

const kbPart = {
  type: "tool-archestra__query_knowledge_sources",
  state: "output-available" as const,
  output: {
    content: JSON.stringify({
      results: [
        {
          citation: {
            title: "Zephyr Billing API Reference",
            sourceUrl: "https://example.com/zephyr",
            connectorType: "web_crawler",
            documentId: DOC,
          },
        },
      ],
    }),
  },
};

const quotes = [
  {
    marker: 1,
    quote: "The limit was raised to 5,000 per minute in March",
    ref: `${DOC}#0`,
    documentId: DOC,
  },
  {
    marker: 2,
    quote: "burst windows of up to 90 seconds are tolerated",
    ref: `${DOC}#0`,
    documentId: DOC,
  },
];

describe("KnowledgeGraphCitations quote expansion", () => {
  it("renders identical image payloads only once across repeated tool calls", () => {
    const image = {
      type: "image",
      data: "UklGRg==",
      mimeType: "image/webp",
    };
    const parts = ["call-1", "call-2"].map((toolCallId) => ({
      type: "tool-archestra__run_tool",
      toolCallId,
      state: "output-available",
      input: { tool_name: "archestra__query_knowledge_sources" },
      output: { content: "[image]", rawContent: [image] },
    }));

    render(<KnowledgeGraphCitations parts={parts as never} />);

    expect(
      screen.getAllByAltText("Image retrieved from the knowledge base"),
    ).toHaveLength(1);
  });

  it("toggles the verbatim quotes behind a chip", async () => {
    const user = userEvent.setup();
    render(<KnowledgeGraphCitations parts={[kbPart]} citedQuotes={quotes} />);

    const chip = screen.getByRole("button", { expanded: false });
    expect(chip).toHaveTextContent("Zephyr Billing API Reference");
    // Marker superscripts tie the chip to the answer's inline references.
    expect(chip).toHaveTextContent("¹ ²");
    expect(
      screen.queryByText(/limit was raised to 5,000/),
    ).not.toBeInTheDocument();

    await user.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/limit was raised to 5,000/)).toBeInTheDocument();
    expect(screen.getByText(/burst windows of up to 90/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open source/i })).toHaveAttribute(
      "href",
      "https://example.com/zephyr",
    );

    await user.click(chip);
    expect(
      screen.queryByText(/limit was raised to 5,000/),
    ).not.toBeInTheDocument();
  });

  it("keeps the plain link chip when a document has no quotes", () => {
    render(<KnowledgeGraphCitations parts={[kbPart]} citedQuotes={[]} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      "https://example.com/zephyr",
    );
  });
});
