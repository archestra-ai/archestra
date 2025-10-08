"use client";

import type { GetInteractionsResponses } from "@shared/api-client";
import { ChevronRight, Copy } from "lucide-react";
import { Suspense, useState } from "react";
import { toast } from "sonner";
import { LoadingSpinner } from "@/components/loading";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useInteractions } from "@/lib/interaction.query";
import { formatDate } from "@/lib/utils";
import { ErrorBoundary } from "../_parts/error-boundary";

export default function LogsPage({
  initialData,
}: {
  initialData?: GetInteractionsResponses["200"];
}) {
  return (
    <div className="container mx-auto p-6">
      <h1 className="text-3xl font-bold mb-6">Logs</h1>
      <ErrorBoundary>
        <Suspense fallback={<LoadingSpinner />}>
          <Logs initialData={initialData} />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

function Logs({
  initialData,
}: {
  initialData?: GetInteractionsResponses["200"];
}) {
  const { data: interactions = [] } = useInteractions({ initialData });
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
          <Card key={interaction.id}>
            <AccordionItem value={interaction.id} className="border-0">
              <CardHeader className="pb-3">
                <AccordionTrigger className="hover:no-underline">
                  <div className="flex items-center justify-between w-full pr-4">
                    <div className="flex items-center gap-4">
                      <div className="flex flex-col items-start">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">
                            {interaction.request.model}
                          </span>
                          <Badge variant="outline" className="text-xs">
                            {interaction.response.choices?.[0]?.finish_reason ||
                              "unknown"}
                          </Badge>
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {formatDate({ date: interaction.createdAt })}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigator.clipboard.writeText(interaction.id);
                          toast.success("ID copied to clipboard");
                        }}
                        className="p-1 hover:bg-muted rounded"
                      >
                        <Copy className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                </AccordionTrigger>
              </CardHeader>
              <AccordionContent>
                <CardContent className="space-y-4 pt-0">
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <h3 className="font-semibold text-sm flex items-center gap-1">
                        <ChevronRight className="h-4 w-4" />
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
                        <ChevronRight className="h-4 w-4" />
                        Response
                      </h3>
                      <div className="rounded-lg bg-muted p-3">
                        <pre className="text-xs overflow-auto max-h-[400px]">
                          {JSON.stringify(interaction.response, null, 2)}
                        </pre>
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-4 text-xs text-muted-foreground">
                    <div>
                      <span className="font-medium">Agent ID:</span>{" "}
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard.writeText(interaction.agentId);
                          toast.success("Agent ID copied to clipboard");
                        }}
                        className="hover:underline"
                      >
                        {interaction.agentId}
                      </button>
                    </div>
                    <div>
                      <span className="font-medium">Interaction ID:</span>{" "}
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard.writeText(interaction.id);
                          toast.success("Interaction ID copied to clipboard");
                        }}
                        className="hover:underline"
                      >
                        {interaction.id}
                      </button>
                    </div>
                  </div>
                </CardContent>
              </AccordionContent>
            </AccordionItem>
          </Card>
        ))}
      </Accordion>
    </div>
  );
}
