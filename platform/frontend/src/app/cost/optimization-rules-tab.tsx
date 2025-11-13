"use client";

import { Edit, Plus, Save, Trash2, X } from "lucide-react";
import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
import type {
  CreateOptimizationRuleInput,
  OptimizationRule,
} from "@/lib/optimization-rule.query";
import {
  useCreateOptimizationRule,
  useDeleteOptimizationRule,
  useUpdateOptimizationRule,
} from "@/lib/optimization-rule.query";

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

// Form data type for inline editing - uses strings for number inputs
type RuleFormData = {
  id?: string;
  agentId: string;
  ruleType: OptimizationRule["ruleType"];
  maxLength?: string;
  hasTools?: boolean;
  provider: OptimizationRule["provider"];
  targetModel: string;
  priority: string;
  enabled: boolean;
};

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

// Helper to convert form data to API input format
function formDataToConditions(
  data: RuleFormData,
): CreateOptimizationRuleInput["conditions"] {
  return data.ruleType === "content_length"
    ? { maxLength: Number(data.maxLength) }
    : { hasTools: data.hasTools ?? false };
}

// Inline Form Component for adding/editing optimization rules
function OptimizationRuleInlineForm({
  initialData,
  onSave,
  onCancel,
}: {
  initialData?: RuleFormData;
  onSave: (data: RuleFormData) => void;
  onCancel: () => void;
}) {
  const [formData, setFormData] = useState<RuleFormData>({
    id: initialData?.id,
    agentId: initialData?.agentId || "",
    ruleType: initialData?.ruleType || "content_length",
    maxLength: initialData?.maxLength || "",
    hasTools: initialData?.hasTools ?? false,
    provider: initialData?.provider || "anthropic",
    targetModel: initialData?.targetModel || "",
    priority: initialData?.priority || "1",
    enabled: initialData?.enabled ?? true,
  });

  const handleSubmit = () => {
    onSave(formData);
  };

  const isValid =
    formData.ruleType &&
    (formData.ruleType === "content_length"
      ? formData.maxLength
      : formData.hasTools !== undefined) &&
    formData.provider &&
    formData.targetModel &&
    formData.priority;

  return (
    <TableRow className="bg-muted/30">
      <TableCell className="p-2">
        <Select
          value={formData.enabled ? "enabled" : "disabled"}
          onValueChange={(value) =>
            setFormData({ ...formData, enabled: value === "enabled" })
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="enabled">Enabled</SelectItem>
            <SelectItem value="disabled">Disabled</SelectItem>
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell className="p-2">
        <Select
          value={formData.ruleType}
          onValueChange={(value: "content_length" | "tool_presence") =>
            setFormData({ ...formData, ruleType: value })
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="content_length">Content Length</SelectItem>
            <SelectItem value="tool_presence">Tool Presence</SelectItem>
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell className="p-2">
        {formData.ruleType === "content_length" ? (
          <Input
            id="maxLength"
            type="number"
            min="0"
            value={formData.maxLength}
            onChange={(e) =>
              setFormData({ ...formData, maxLength: e.target.value })
            }
            placeholder="1000"
            required
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (isValid) handleSubmit();
              }
            }}
          />
        ) : (
          <Select
            value={formData.hasTools ? "true" : "false"}
            onValueChange={(value) =>
              setFormData({ ...formData, hasTools: value === "true" })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="true">With tools</SelectItem>
              <SelectItem value="false">Without tools</SelectItem>
            </SelectContent>
          </Select>
        )}
      </TableCell>
      <TableCell className="p-2">
        <Select
          value={formData.provider}
          onValueChange={(value: "anthropic" | "openai") =>
            setFormData({ ...formData, provider: value })
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="anthropic">Anthropic</SelectItem>
            <SelectItem value="openai">OpenAI</SelectItem>
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell className="p-2">
        <Input
          id="targetModel"
          type="text"
          value={formData.targetModel}
          onChange={(e) =>
            setFormData({ ...formData, targetModel: e.target.value })
          }
          placeholder={
            formData.provider === "openai" ? "gpt-4o-mini" : "claude-4-5-haiku"
          }
          required
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (isValid) handleSubmit();
            }
          }}
        />
      </TableCell>
      <TableCell className="p-2 w-20">
        <Input
          id="priority"
          type="number"
          min="1"
          value={formData.priority}
          onChange={(e) =>
            setFormData({ ...formData, priority: e.target.value })
          }
          placeholder="1"
          required
          className="w-full"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (isValid) handleSubmit();
            }
          }}
        />
      </TableCell>
      <TableCell className="p-2 w-48">
        <div className="flex gap-2">
          <Button onClick={() => handleSubmit()} disabled={!isValid} size="sm">
            <Save className="h-4 w-4 mr-1" />
            Save
          </Button>
          <Button type="button" variant="outline" onClick={onCancel} size="sm">
            <X className="h-4 w-4 mr-1" />
            Cancel
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

// Optimization Rule Row Component for displaying/editing individual rules
function OptimizationRuleRow({
  rule,
  isEditing,
  onEdit,
  onSave,
  onCancel,
  onDelete,
}: {
  rule: OptimizationRule;
  isEditing: boolean;
  onEdit: () => void;
  onSave: (data: RuleFormData) => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  if (isEditing) {
    const formData: RuleFormData = {
      id: rule.id,
      agentId: rule.agentId,
      ruleType: rule.ruleType,
      maxLength:
        rule.ruleType === "content_length"
          ? String((rule.conditions as { maxLength: number }).maxLength)
          : undefined,
      hasTools:
        rule.ruleType === "tool_presence"
          ? (rule.conditions as { hasTools: boolean }).hasTools
          : undefined,
      provider: rule.provider,
      targetModel: rule.targetModel,
      priority: String(rule.priority),
      enabled: rule.enabled,
    };

    return (
      <OptimizationRuleInlineForm
        initialData={formData}
        onSave={onSave}
        onCancel={onCancel}
      />
    );
  }

  return (
    <TableRow className="hover:bg-muted/30">
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
      <TableCell className="capitalize">{rule.provider}</TableCell>
      <TableCell>{rule.targetModel}</TableCell>
      <TableCell>{rule.priority}</TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onEdit}>
            <Edit className="h-4 w-4" />
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete Optimization Rule</AlertDialogTitle>
                <AlertDialogDescription>
                  Are you sure you want to delete this optimization rule? This
                  action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={onDelete}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </TableCell>
    </TableRow>
  );
}

export function OptimizationRulesTab({
  selectedAgentId,
  setSelectedAgentId,
  agents,
  optimizationRules,
  optimizationRulesLoading,
}: OptimizationRulesTabProps) {
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [isAddingRule, setIsAddingRule] = useState(false);

  const createRule = useCreateOptimizationRule();
  const updateRule = useUpdateOptimizationRule();
  const deleteRule = useDeleteOptimizationRule();

  const handleCreateRule = async (data: RuleFormData) => {
    try {
      await createRule.mutateAsync({
        agentId: data.agentId,
        ruleType: data.ruleType,
        conditions: formDataToConditions(data),
        provider: data.provider,
        targetModel: data.targetModel,
        priority: Number(data.priority),
        enabled: data.enabled,
      });
      setIsAddingRule(false);
    } catch (error) {
      console.error("Failed to create optimization rule:", error);
    }
  };

  const handleUpdateRule = async (id: string, data: RuleFormData) => {
    try {
      await updateRule.mutateAsync({
        id,
        ruleType: data.ruleType,
        conditions: formDataToConditions(data),
        provider: data.provider,
        targetModel: data.targetModel,
        priority: Number(data.priority),
        enabled: data.enabled,
      });
      setEditingRuleId(null);
    } catch (error) {
      console.error("Failed to update optimization rule:", error);
    }
  };

  const handleDeleteRule = async (id: string) => {
    try {
      await deleteRule.mutateAsync(id);
    } catch (error) {
      console.error("Failed to delete optimization rule:", error);
    }
  };

  const handleCancelEdit = () => {
    setEditingRuleId(null);
    setIsAddingRule(false);
  };

  return (
    <TabsContent value="optimization-rules" className="mt-0">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Optimization Rules</CardTitle>
              <CardDescription>
                Add rules to select a cheaper model if content is short or there
                are no tools
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
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
              {selectedAgentId && !isAddingRule && (
                <Button
                  onClick={() => setIsAddingRule(true)}
                  size="sm"
                  variant="outline"
                >
                  <Plus className="h-4 w-4 mr-1" />
                  Add Rule
                </Button>
              )}
            </div>
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
                  <TableHead className="w-20">Priority</TableHead>
                  <TableHead className="w-48">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isAddingRule && selectedAgentId && (
                  <OptimizationRuleInlineForm
                    initialData={{
                      agentId: selectedAgentId,
                      ruleType: "content_length",
                      provider: "anthropic",
                      targetModel: "",
                      priority: "1",
                      enabled: true,
                    }}
                    onSave={handleCreateRule}
                    onCancel={handleCancelEdit}
                  />
                )}
                {optimizationRules.length === 0 && !isAddingRule ? (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="text-center py-8 text-muted-foreground"
                    >
                      {selectedAgentId
                        ? "No optimization rules configured for this agent"
                        : "Select an agent to view optimization rules"}
                    </TableCell>
                  </TableRow>
                ) : (
                  optimizationRules.map((rule) => (
                    <OptimizationRuleRow
                      key={rule.id}
                      rule={rule}
                      isEditing={editingRuleId === rule.id}
                      onEdit={() => setEditingRuleId(rule.id)}
                      onSave={(data) => handleUpdateRule(rule.id, data)}
                      onCancel={handleCancelEdit}
                      onDelete={() => handleDeleteRule(rule.id)}
                    />
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
