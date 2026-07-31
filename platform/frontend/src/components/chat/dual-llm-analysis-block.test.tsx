import type { DualLlmAnalysisPartData } from "@archestra/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DualLlmAnalysisBlock } from "./dual-llm-analysis-block";

const doneData: DualLlmAnalysisPartData = {
  toolCallId: "call_1",
  toolName: "web_fetch",
  status: "done",
  rounds: [
    {
      question: "Primary topic?",
      options: ["security", "recipes"],
      answer: "0",
    },
  ],
  summary: "A security article.",
};

describe("DualLlmAnalysisBlock", () => {
  it("renders collapsed with the tool name and round count", () => {
    render(<DualLlmAnalysisBlock data={doneData} />);
    expect(screen.getByText(/web_fetch/)).toBeInTheDocument();
    expect(screen.getByText(/1 question/)).toBeInTheDocument();
    // Collapsed by default: the interrogation content is not shown.
    expect(screen.queryByText("Primary topic?")).not.toBeInTheDocument();
  });

  it("labels a cached analysis and shows analyzing progress", () => {
    render(
      <DualLlmAnalysisBlock
        data={{ ...doneData, cached: true, rounds: [], questionCount: 3 }}
      />,
    );
    expect(screen.getByText(/3 questions \(cached\)/)).toBeInTheDocument();

    render(
      <DualLlmAnalysisBlock
        data={{ ...doneData, status: "analyzing", summary: undefined }}
      />,
    );
    expect(
      screen.getByText(/analyzing — 1 question so far/),
    ).toBeInTheDocument();
  });

  it("renders a failed analysis open with its failure message", () => {
    render(
      <DualLlmAnalysisBlock
        data={{
          ...doneData,
          status: "failed",
          summary: undefined,
          failureMessage: "Sanitization failed for web_fetch",
        }}
      />,
    );
    expect(
      screen.getByText(/Sanitization failed for web_fetch/),
    ).toBeInTheDocument();
  });
});
