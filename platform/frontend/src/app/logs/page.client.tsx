"use client";

import type {
  GetAgentsResponses,
  GetInteractionsResponses,
} from "@shared/api-client";
import { ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import { Suspense, useState } from "react";
import Divider from "@/components/divider";
import { InteractionSummary } from "@/components/interaction-summary";
import { LoadingSpinner } from "@/components/loading";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Tabs } from "@/components/ui/tabs";
import { useAgents } from "@/lib/agent.query";
import { useInteractions } from "@/lib/interaction.query";
import { ErrorBoundary } from "../_parts/error-boundary";

const TabsOptions = {
  Table: "Table",
  Raw: "Raw data",
} as const;

export default function LogsPage({
  initialData,
}: {
  initialData?: {
    interactions: GetInteractionsResponses["200"];
    agents: GetAgentsResponses["200"];
  };
}) {
  return (
    <div className="container mx-auto p-6">
      <Tabs defaultValue={TabsOptions.Table}>
        <div className="flex flex-col gap-1 mb-2">
          <h1 className="text-3xl font-bold mb-6">Logs</h1>
        </div>
        <ErrorBoundary>
          <Suspense fallback={<LoadingSpinner />}>
            <LogsRaw initialData={initialData} />
          </Suspense>
        </ErrorBoundary>
      </Tabs>
    </div>
  );
}

function LogsRaw({
  initialData,
}: {
  initialData?: {
    interactions: GetInteractionsResponses["200"];
    agents: GetAgentsResponses["200"];
  };
}) {
  const { data: interactions = [] } = useInteractions({
    initialData: initialData?.interactions,
  });
  const { data: agents = [] } = useAgents({
    initialData: initialData?.agents,
  });
  const [expandedItems, setExpandedItems] = useState<string[]>([]);

  if (!interactions || interactions.length === 0) {
    return <p className="text-muted-foreground">No logs found</p>;
  }

  return (
    <div className="space-y-4">
      <Accordion
        type="multiple"
        value={expandedItems}
        onValueChange={setExpandedItems}
        className="space-y-4"
      >
        {interactions.map((interaction) => (
          <LogRow
            key={interaction.id}
            interaction={interaction}
            agent={agents?.find((agent) => agent.id === interaction.agentId)}
          />
        ))}
      </Accordion>
    </div>
  );
}

function LogRow({
  interaction,
  agent,
}: {
  interaction: GetInteractionsResponses["200"][number];
  agent?: GetAgentsResponses["200"][number];
}) {
  return (
    <Card className="p-0">
      <AccordionItem value={interaction.id} className="border-0">
        <CardHeader className="py-4 relative pb-12">
          <div className="absolute top-0 right-4 z-10">
            <AccordionTrigger className="hover:no-underline items-center" />
          </div>
          <InteractionSummary interaction={interaction} agent={agent} />
          <Link
            href={`/logs/${interaction.id}`}
            className="absolute bottom-4 right-4 flex items-center gap-1 text-sm text-primary hover:underline z-10 mt-4"
          >
            Open <ChevronRightIcon className="w-4 h-4 mt-[1px]" />
          </Link>
        </CardHeader>
        <AccordionContent>
          <CardContent className="space-y-4 pt-0">
            <Divider className="mb-6" />
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <h3 className="font-semibold text-sm flex items-center gap-1">
                  Request
                </h3>
                <div className="rounded-lg bg-muted p-3">
                  <pre className="text-xs overflow-auto max-h-[400px]">
                    {JSON.stringify(interaction.request, null, 2)}
                  </pre>
                </div>
              </div>
              <div className="space-y-2">
                <h3 className="font-semibold text-sm flex items-center gap-1">
                  Response
                </h3>
                <div className="rounded-lg bg-muted p-3">
                  <pre className="text-xs overflow-auto max-h-[400px]">
                    {JSON.stringify(interaction.response, null, 2)}
                  </pre>
                </div>
              </div>
            </div>
            <Divider className="mb-4" />
            <div className="flex gap-4 text-xs text-muted-foreground">
              <span className="font-medium">
                Agent ID: {interaction.agentId}
              </span>
              <span className="font-medium">
                Interaction ID: {interaction.id}
              </span>
            </div>
          </CardContent>
        </AccordionContent>
      </AccordionItem>
    </Card>
  );
}
