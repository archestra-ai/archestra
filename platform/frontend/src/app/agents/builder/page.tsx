"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { AgentsCanvasView } from "@/components/agents-canvas/agents-canvas-view";
import { PageLayout } from "@/components/page-layout";
import { Button } from "@/components/ui/button";

export default function AgentsBuilderPage() {
  return (
    <PageLayout
      title="Agent Builder"
      description="Visualize and manage agent relationships and delegations."
      actionButton={
        <Button variant="outline" asChild>
          <Link href="/agents">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Agents
          </Link>
        </Button>
      }
    >
      <AgentsCanvasView />
    </PageLayout>
  );
}
