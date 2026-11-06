import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmbeddingVectors } from "./embedding-vectors";

const vector = Array.from(
  { length: 1536 },
  (_, index) => Math.sin(index / 7) * 0.08,
);

describe("EmbeddingVectors", () => {
  it("names the embedding and draws its vector with its range", () => {
    render(
      <EmbeddingVectors
        data={{ count: 1, dimensions: 1536, vectors: [{ values: vector }] }}
      />,
    );
    expect(screen.getByText("1 embedding")).toBeVisible();
    expect(screen.getByText("· 1,536 dimensions")).toBeVisible();
    expect(
      screen.getByRole("img", {
        name: /^1,536 values from -0\.080 to 0\.080$/,
      }),
    ).toBeInTheDocument();
  });

  it("labels each vector of a batch with its input and counts the rest", () => {
    render(
      <EmbeddingVectors
        data={{
          count: 7,
          dimensions: 1536,
          vectors: ["refund policy", "return an item"].map((label) => ({
            label,
            values: vector,
          })),
        }}
      />,
    );
    expect(screen.getByText("7 embeddings")).toBeVisible();
    expect(screen.getByText("· 1,536 dimensions each")).toBeVisible();
    expect(screen.getByText("refund policy")).toBeVisible();
    expect(screen.getByText("return an item")).toBeVisible();
    expect(screen.getAllByRole("img")).toHaveLength(2);
    expect(
      screen.getByText("5 more embeddings are in the Response view."),
    ).toBeVisible();
  });
});
