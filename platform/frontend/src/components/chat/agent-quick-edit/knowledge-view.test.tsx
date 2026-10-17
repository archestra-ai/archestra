import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { KnowledgeView } from "./knowledge-view";

vi.mock("sonner");

function renderView({ isLoading }: { isLoading: boolean }) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Dialog open>
        <DialogContent>
          <KnowledgeView
            agent={{ id: "agent-1", name: "Support agent" }}
            allKnowledgeBases={[]}
            allConnectors={[]}
            isLoading={isLoading}
            onBack={() => {}}
          />
        </DialogContent>
      </Dialog>
    </QueryClientProvider>,
  );
}

it("says the sources are loading while the pickers load", () => {
  renderView({ isLoading: true });

  expect(screen.getByText("Loading knowledge sources")).toBeTruthy();
  expect(screen.queryByText("No knowledge sources yet")).toBeNull();
  expect(screen.queryByText(/No knowledge sources match/)).toBeNull();
});

it("shows the empty state once the pickers load with nothing", () => {
  renderView({ isLoading: false });

  expect(screen.getByText("No knowledge sources yet")).toBeTruthy();
  expect(screen.queryByText("Loading knowledge sources")).toBeNull();
});
