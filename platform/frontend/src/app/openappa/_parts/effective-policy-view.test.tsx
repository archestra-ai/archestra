import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { EffectivePolicyView } from "./effective-policy-view";

vi.mock("@/components/editor", () => ({
  Editor: ({ value }: { value: string }) => <pre>{value}</pre>,
}));
vi.mock("@/lib/openappa-batteries.query", () => ({
  useEffectivePolicy: () => ({
    isPending: false,
    isError: false,
    data: {
      content: "[policy]\nversion = 2\n",
      contentHash: "0123456789abcdef",
      rootRevision: 3,
      lastError: null,
      servedRevision: {
        revision: 5,
        publishedAt: "2026-10-18T09:30:00.000Z",
      },
    },
  }),
  usePolicyDeclarations: () => ({ data: { batteries: [] } }),
}));

test("the footer names the composed revision and the runtime revision open conversations follow", () => {
  render(<EffectivePolicyView />);

  expect(
    screen.getByText("Composed from revision 3 · 0123456789ab"),
  ).toBeInTheDocument();
  expect(screen.getByText(/Runtime revision 5/)).toHaveTextContent(
    "open conversations follow it",
  );
});
