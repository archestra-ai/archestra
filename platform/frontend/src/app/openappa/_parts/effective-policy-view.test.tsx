import { render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { useGuardrailsDeployment } from "@/lib/guardrails-deployment.query";
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
      retained: null,
      servedRevision: {
        revision: 5,
        publishedAt: "2026-10-18T09:30:00.000Z",
      },
    },
  }),
  usePolicyDeclarations: () => ({ data: { batteries: [] } }),
}));
vi.mock("@/lib/guardrails-deployment.query", () => ({
  useGuardrailsDeployment: vi.fn(),
}));

const SNAPSHOT_LINE =
  "New sessions keep a policy snapshot: a policy change reaches new sessions only, and no new revision is published";

function deployment(newSessionPolicy: "live" | "snapshot") {
  vi.mocked(useGuardrailsDeployment).mockReturnValue({
    data: { newSessionPolicy },
  } as ReturnType<typeof useGuardrailsDeployment>);
}

beforeEach(() => deployment("live"));

test("the footer says new sessions keep a policy snapshot while it is selected", () => {
  deployment("snapshot");
  render(<EffectivePolicyView />);

  expect(screen.getByTestId("effective-policy")).toHaveTextContent(
    SNAPSHOT_LINE,
  );
  expect(screen.getByText(/Runtime revision 5/)).toBeInTheDocument();
});

test("the footer says nothing about a snapshot while new sessions take the live policy", () => {
  render(<EffectivePolicyView />);

  expect(screen.getByText(/Composed from revision 3/)).toBeInTheDocument();
  expect(screen.queryByText(/policy snapshot/)).toBeNull();
});
