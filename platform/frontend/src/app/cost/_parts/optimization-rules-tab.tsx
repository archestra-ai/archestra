"use client";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TabsContent } from "@/components/ui/tabs";
import type { OptimizationRule } from "@/lib/optimization-rule.query";

interface Agent {
  id: string;
  name: string;
}

interface OptimizationRulesTabProps {
  selectedAgentId: string | null;
  setSelectedAgentId: (id: string | null) => void;
  agents: Agent[];
  optimizationRules: OptimizationRule[];
  optimizationRulesLoading: boolean;
}

function LoadingSkeleton({ count, prefix }: { count: number; prefix: string }) {
  const skeletons = Array.from(
    { length: count },
    (_, i) => `${prefix}-skeleton-${i}`,
  );

  return (
    <div className="space-y-3">
      {skeletons.map((key) => (
        <div key={key} className="h-16 bg-muted animate-pulse rounded" />
      ))}
    </div>
  );
}

export function OptimizationRulesTab({
  selectedAgentId,
  setSelectedAgentId,
  agents,
  optimizationRules,
  optimizationRulesLoading,
}: OptimizationRulesTabProps) {
  return (
    <TabsContent value="optimization-rules" className="mt-0">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Optimization Rules</CardTitle>
              <CardDescription>
                Dynamic model optimization rules for cost savings
              </CardDescription>
            </div>
            <Select
              value={selectedAgentId || ""}
              onValueChange={setSelectedAgentId}
            >
              <SelectTrigger className="w-48">
                <SelectValue placeholder="Select an agent" />
              </SelectTrigger>
              <SelectContent>
                {agents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {optimizationRulesLoading ? (
            <LoadingSkeleton count={3} prefix="optimization-rules" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Rule Type</TableHead>
                  <TableHead>Conditions</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Target Model</TableHead>
                  <TableHead>Priority</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {optimizationRules.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="text-center py-8 text-muted-foreground"
                    >
                      {selectedAgentId
                        ? "No optimization rules configured for this agent"
                        : "Select an agent to view optimization rules"}
                    </TableCell>
                  </TableRow>
                ) : (
                  optimizationRules.map((rule) => (
                    <TableRow key={rule.id}>
                      <TableCell>
                        <Badge variant={rule.enabled ? "default" : "secondary"}>
                          {rule.enabled ? "Enabled" : "Disabled"}
                        </Badge>
                      </TableCell>
                      <TableCell className="capitalize">
                        {rule.ruleType.replace("_", " ")}
                      </TableCell>
                      <TableCell>
                        {rule.ruleType === "content_length"
                          ? `Max ${(rule.conditions as { maxLength: number }).maxLength} chars`
                          : (rule.conditions as { hasTools: boolean }).hasTools
                            ? "With tools"
                            : "Without tools"}
                      </TableCell>
                      <TableCell className="capitalize">
                        {rule.provider}
                      </TableCell>
                      <TableCell>{rule.targetModel}</TableCell>
                      <TableCell>{rule.priority}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </TabsContent>
  );
}
