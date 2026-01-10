"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use } from "react";
import { TruncatedText } from "@/components/truncated-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useInteractions } from "@/lib/interaction.query";
import { DynamicInteraction } from "@/lib/interaction.utils";
import { formatDate } from "@/lib/utils";

export default function SessionDetailPage({
  paramsPromise,
}: {
  paramsPromise: Promise<{ sessionId: string }>;
}) {
  const params = use(paramsPromise);
  const router = useRouter();

  const { data: interactionsResponse } = useInteractions({
    sessionId: params.sessionId,
    limit: 500, // Get all interactions for this session
    offset: 0,
    sortBy: "createdAt",
    sortDirection: "desc",
  });

  const interactions = interactionsResponse?.data ?? [];

  // Calculate session summary
  const totalInputTokens = interactions.reduce(
    (sum, i) => sum + (i.inputTokens ?? 0),
    0,
  );
  const totalOutputTokens = interactions.reduce(
    (sum, i) => sum + (i.outputTokens ?? 0),
    0,
  );
  const models = [...new Set(interactions.map((i) => i.model).filter(Boolean))];
  const firstRequest =
    interactions.length > 0
      ? interactions[interactions.length - 1].createdAt
      : null;
  const lastRequest =
    interactions.length > 0 ? interactions[0].createdAt : null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/logs/llm-proxy">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Sessions
          </Link>
        </Button>
      </div>

      {/* Session Summary */}
      <div className="rounded-lg border p-4 space-y-4">
        <h2 className="text-lg font-semibold">Session Details</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <div className="text-muted-foreground">Session ID</div>
            <div className="font-mono text-xs break-all">
              {params.sessionId}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Total Requests</div>
            <div className="font-semibold">{interactions.length}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Total Tokens</div>
            <div className="font-mono">
              {totalInputTokens.toLocaleString()} in /{" "}
              {totalOutputTokens.toLocaleString()} out
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Models</div>
            <div className="flex flex-wrap gap-1">
              {models.map((model) => (
                <Badge key={model} variant="secondary" className="text-xs">
                  {model}
                </Badge>
              ))}
            </div>
          </div>
          {firstRequest && (
            <div>
              <div className="text-muted-foreground">First Request</div>
              <div className="font-mono text-xs">
                {formatDate({ date: firstRequest })}
              </div>
            </div>
          )}
          {lastRequest && (
            <div>
              <div className="text-muted-foreground">Last Request</div>
              <div className="font-mono text-xs">
                {formatDate({ date: lastRequest })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Interactions Table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[160px]">Time</TableHead>
              <TableHead className="w-[180px]">Model</TableHead>
              <TableHead className="w-[120px]">Tokens (In/Out)</TableHead>
              <TableHead>User Message</TableHead>
              <TableHead className="w-[200px]">Assistant Response</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {interactions.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="text-center text-muted-foreground"
                >
                  No interactions found for this session
                </TableCell>
              </TableRow>
            ) : (
              interactions.map((interaction) => {
                const dynamicInteraction = new DynamicInteraction(interaction);
                const userMessage = dynamicInteraction.getLastUserMessage();
                const assistantResponse =
                  dynamicInteraction.getLastAssistantResponse();

                return (
                  <TableRow
                    key={interaction.id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => router.push(`/logs/${interaction.id}`)}
                  >
                    <TableCell className="font-mono text-xs">
                      {formatDate({ date: dynamicInteraction.createdAt })}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="text-xs">
                        {dynamicInteraction.modelName}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {(interaction.inputTokens ?? 0).toLocaleString()} /{" "}
                      {(interaction.outputTokens ?? 0).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-xs">
                      <TruncatedText message={userMessage} maxLength={100} />
                    </TableCell>
                    <TableCell className="text-xs">
                      <TruncatedText
                        message={assistantResponse}
                        maxLength={60}
                      />
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
