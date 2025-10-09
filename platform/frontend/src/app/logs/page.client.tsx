"use client";

import type {
  GetAgentsResponses,
  GetInteractionsResponses,
} from "@shared/api-client";
import {
  BrainIcon,
  CalendarDaysIcon,
  HatGlassesIcon,
  MessageSquareMoreIcon,
} from "lucide-react";
import { type ReactElement, Suspense, useState } from "react";
import Divider from "@/components/divider";
import { LoadingSpinner } from "@/components/loading";
import { TruncatedText } from "@/components/truncated-text";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAgents } from "@/lib/agent.query";
import { useInteractions } from "@/lib/interaction.query";
import { formatDate } from "@/lib/utils";
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
          <span className="text-sm text-muted-foreground">Display as</span>
          <TabsList>
            <TabsTrigger value={TabsOptions.Table}>
              {TabsOptions.Table}
            </TabsTrigger>
            <TabsTrigger value={TabsOptions.Raw}>{TabsOptions.Raw}</TabsTrigger>
          </TabsList>
        </div>
        <ErrorBoundary>
          <Suspense fallback={<LoadingSpinner />}>
            <TabsContent value={TabsOptions.Table}>
              Make changes to your account here.
            </TabsContent>
            <TabsContent value={TabsOptions.Raw}>
              <LogsRaw initialData={initialData} />
            </TabsContent>
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
  const [agentNameTruncated, _setAgentNameTruncated] = useState(false);
  const [lastMessageTruncated, _setLastMessageTruncated] = useState(false);

  const iconClassName = "w-4 h-4";

  return (
    <Card className="p-0">
      <AccordionItem value={interaction.id} className="border-0">
        <CardHeader className="py-4">
          <div className="flex items-start w-full gap-4 pr-4">
            <RawLogDetail
              label="Date"
              value={formatDate({ date: interaction.createdAt })}
              icon={<CalendarDaysIcon className={iconClassName} />}
              width="15%"
            />
            <RawLogDetail
              label="Model"
              value={interaction.request.model}
              icon={<BrainIcon className={iconClassName} />}
              width="10%"
            />
            <RawLogDetail
              label="Agent name"
              value={<TruncatedText message={agent?.name ?? "Unknown"} />}
              icon={<HatGlassesIcon className={iconClassName} />}
              width="30%"
              isTruncated={agentNameTruncated}
            />
            <RawLogDetail
              label="Last user message"
              value={
                <TruncatedText message={findLastUserMessage(interaction)} />
              }
              icon={<MessageSquareMoreIcon className={iconClassName} />}
              width="40%"
              isTruncated={lastMessageTruncated}
            />
            <div className="flex-shrink-0">
              <AccordionTrigger className="hover:no-underline items-center" />
            </div>
          </div>
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

function findLastUserMessage(
  interaction: GetInteractionsResponses["200"][number],
): string {
  const reversedMessages = [...interaction.request.messages].reverse();
  for (const message of reversedMessages) {
    if (message.role !== "user") {
      continue;
    }
    if (typeof message.content === "string") {
      return message.content;
    }
    if (message.content?.[0]?.type === "text") {
      return message.content[0].text;
    }
  }
  return "";
}

function RawLogDetail({
  label,
  value,
  icon,
  width,
  isTruncated,
}: {
  label: string;
  value: string | ReactElement;
  icon: ReactElement;
  width: string;
  isTruncated?: boolean;
}) {
  return (
    <div style={{ width }} className="min-w-0 relative group/detail">
      <span className="flex text-sm text-muted-foreground mb-2 items-center">
        <span className="mr-1">{icon}</span> {label}
      </span>
      <Badge
        variant="secondary"
        className={`flex w-full min-w-0 justify-start ${isTruncated ? "pr-0" : ""} whitespace-normal w-[fit-content]`}
      >
        {value}
      </Badge>
    </div>
  );
}
