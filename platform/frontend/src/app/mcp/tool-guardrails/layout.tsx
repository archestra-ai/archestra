"use client";

import { PageLayout } from "@/components/page-layout";

export default function ToolGuardrailsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <PageLayout
      title="Guardrails"
      description={
        <>
          Tool guardrails control how, when, and in what context tools can be
          called, and how their results are handled before being returned to the
          model.
          <br />
          Tools displayed here are detected from requests between agents and
          LLMs, sourced from installed MCP servers, or provided by agents and
          apps. Their Source tells you which.
        </>
      }
    >
      {children}
    </PageLayout>
  );
}
