import {
  type archestraApiTypes,
  CONTEXT_EXTERNAL_AGENT_ID,
  CONTEXT_TEAM_IDS,
} from "@shared";
import { ArrowRightIcon, FlaskConical, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ButtonWithTooltip } from "@/components/button-with-tooltip";
import { DebouncedInput } from "@/components/debounced-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useUniqueExternalAgentIds } from "@/lib/interactions/interaction.query";
import {
  useCallPolicyMutation,
  useSimulateToolInvocationPoliciesMutation,
  useToolInvocationPolicies,
  useToolInvocationPolicyCreateMutation,
  useToolInvocationPolicyDeleteMutation,
  useToolInvocationPolicyUpdateMutation,
} from "@/lib/policy.query";
import {
  type CallPolicyAction,
  getCallPolicyActionFromPolicies,
} from "@/lib/policy.utils";
import { useTeams } from "@/lib/teams/team.query";
import { CallPolicyToggle } from "./call-policy-toggle";
import { PolicyCard } from "./policy-card";
import {
  type PolicyCondition,
  ToolCallPolicyCondition,
} from "./tool-call-policy-condition";

type ToolInvocationPolicyAction =
  archestraApiTypes.GetToolInvocationPoliciesResponses["200"][number]["action"];

type DraftToolInvocationPolicy = {
  id: string;
  toolId: string;
  conditions: PolicyCondition[];
  action: ToolInvocationPolicyAction;
  reason: string | null;
};

type ToolForPolicies = {
  id: string;
  parameters?: archestraApiTypes.GetToolsWithAssignmentsResponses["200"]["data"][number]["parameters"];
};

export function ToolCallPolicies({ tool }: { tool: ToolForPolicies }) {
  const [mode, setMode] = useState<"current" | "historical">("current");

  const { data: invocationPolicies } = useToolInvocationPolicies();
  const toolInvocationPolicyCreateMutation =
    useToolInvocationPolicyCreateMutation();
  const toolInvocationPolicyDeleteMutation =
    useToolInvocationPolicyDeleteMutation();
  const toolInvocationPolicyUpdateMutation =
    useToolInvocationPolicyUpdateMutation();
  const callPolicyMutation = useCallPolicyMutation();
  const simulatePoliciesMutation = useSimulateToolInvocationPoliciesMutation();
  const { data: externalAgentIds = [] } = useUniqueExternalAgentIds();
  const { data: teams } = useTeams();

  const byProfileToolId = invocationPolicies?.byProfileToolId ?? {};
  const currentPolicies = byProfileToolId[tool.id] || [];

  const [draftPolicies, setDraftPolicies] = useState<DraftToolInvocationPolicy[]>(
    () =>
      currentPolicies.map((policy) => ({
        id: policy.id,
        toolId: policy.toolId,
        conditions: [...policy.conditions],
        action: policy.action,
        reason: policy.reason,
      })),
  );
  const [simulationResult, setSimulationResult] = useState<{
    summary: {
      totalCalls: number;
      newlyBlocked: number;
      newlyAllowed: number;
      requireApprovalAdded: number;
      requireApprovalRemoved: number;
      noChange: number;
    };
    details: {
      mcpToolCallId: string;
      toolName: string;
      agentId: string | null;
      calledAt: string;
      currentOutcome: "allowed" | "blocked" | "require_approval";
      simulatedOutcome: "allowed" | "blocked" | "require_approval";
      changed: boolean;
      changedReason?: string;
    }[];
  } | null>(null);

  useEffect(() => {
    setMode("current");
    setDraftPolicies(
      currentPolicies.map((policy) => ({
        id: policy.id,
        toolId: policy.toolId,
        conditions: [...policy.conditions],
        action: policy.action,
        reason: policy.reason,
      })),
    );
    setSimulationResult(null);
  }, [tool.id]);

  useEffect(() => {
    if (mode !== "current") return;
    setDraftPolicies(
      currentPolicies.map((policy) => ({
        id: policy.id,
        toolId: policy.toolId,
        conditions: [...policy.conditions],
        action: policy.action,
        reason: policy.reason,
      })),
    );
  }, [currentPolicies, mode]);

  const allPolicies = useMemo(() => {
    if (mode === "historical") {
      return draftPolicies;
    }
    return currentPolicies;
  }, [mode, draftPolicies, currentPolicies]);

  const policies = allPolicies.filter((policy) => policy.conditions.length > 0);

  const argumentNames = Object.keys(tool.parameters?.properties || {});
  const contextOptions = [
    ...(externalAgentIds.length > 0 ? [CONTEXT_EXTERNAL_AGENT_ID] : []),
    ...((teams?.length ?? 0) > 0 ? [CONTEXT_TEAM_IDS] : []),
  ];
  const conditionKeyOptions = [...argumentNames, ...contextOptions];

  const currentAction = getCallPolicyActionFromPolicies(tool.id, {
    byProfileToolId: { [tool.id]: allPolicies },
  });

  const getDefaultConditionKey = () =>
    argumentNames[0] ??
    (externalAgentIds.length > 0
      ? CONTEXT_EXTERNAL_AGENT_ID
      : CONTEXT_TEAM_IDS);

  const setDraftPolicy = (
    policyId: string,
    updater: (policy: DraftToolInvocationPolicy) => DraftToolInvocationPolicy,
  ) => {
    setDraftPolicies((prev) =>
      prev.map((policy) => (policy.id === policyId ? updater(policy) : policy)),
    );
  };

  const resetDraftFromCurrent = () => {
    setDraftPolicies(
      currentPolicies.map((policy) => ({
        id: policy.id,
        toolId: policy.toolId,
        conditions: [...policy.conditions],
        action: policy.action,
        reason: policy.reason,
      })),
    );
    setSimulationResult(null);
  };

  const runSimulation = async () => {
    const result = await simulatePoliciesMutation.mutateAsync({
      candidatePolicies: draftPolicies.map((policy) => ({
        toolId: tool.id,
        conditions: policy.conditions,
        action: policy.action,
        reason: policy.reason,
      })),
      limit: 200,
      globalToolPolicy: "restrictive",
    });

    if (result) {
      setSimulationResult(result);
    }
  };

  const setModeAndSyncDraft = (newMode: "current" | "historical") => {
    if (newMode === mode) return;
    if (newMode === "historical") {
      resetDraftFromCurrent();
    }
    setMode(newMode);
  };

  const policyOptionItems: { value: ToolInvocationPolicyAction; label: string }[] =
    [
      { value: "allow_when_context_is_untrusted", label: "Allow always" },
      {
        value: "block_when_context_is_untrusted",
        label: "Allow in safe context",
      },
      { value: "require_approval", label: "Require approval" },
      { value: "block_always", label: "Block always" },
    ];

  const getOutcomeBadgeClass = (
    outcome: "allowed" | "blocked" | "require_approval",
  ) => {
    if (outcome === "blocked") return "bg-red-600 text-white";
    if (outcome === "require_approval") return "bg-amber-500 text-black";
    return "bg-emerald-600 text-white";
  };

  const handleConditionChange = (
    policy: (typeof policies)[number],
    index: number,
    updatedCondition: PolicyCondition,
  ) => {
    if (mode === "historical") {
      setDraftPolicy(policy.id, (current) => {
        const newConditions = [...current.conditions];
        newConditions[index] = updatedCondition;
        return { ...current, conditions: newConditions };
      });
      return;
    }

    const newConditions = [...policy.conditions];
    newConditions[index] = updatedCondition;
    toolInvocationPolicyUpdateMutation.mutate({
      id: policy.id,
      conditions: newConditions,
    });
  };

  const handleConditionRemove = (
    policy: (typeof policies)[number],
    index: number,
  ) => {
    if (mode === "historical") {
      setDraftPolicy(policy.id, (current) => ({
        ...current,
        conditions: current.conditions.filter((_, i) => i !== index),
      }));
      return;
    }

    const newConditions = policy.conditions.filter(
      (_: unknown, i: number) => i !== index,
    );
    toolInvocationPolicyUpdateMutation.mutate({
      id: policy.id,
      conditions: newConditions,
    });
  };

  const handleConditionAdd = (policy: (typeof policies)[number]) => {
    if (mode === "historical") {
      setDraftPolicy(policy.id, (current) => ({
        ...current,
        conditions: [
          ...current.conditions,
          { key: getDefaultConditionKey(), operator: "equal", value: "" },
        ],
      }));
      return;
    }

    const newConditions: PolicyCondition[] = [
      ...policy.conditions,
      { key: getDefaultConditionKey(), operator: "equal", value: "" },
    ];
    toolInvocationPolicyUpdateMutation.mutate({
      id: policy.id,
      conditions: newConditions,
    });
  };

  const handleActionChange = (action: CallPolicyAction) => {
    if (action === currentAction) return;

    if (mode === "historical") {
      const existingDefaultPolicy = draftPolicies.find(
        (policy) => policy.conditions.length === 0,
      );

      if (existingDefaultPolicy) {
        setDraftPolicy(existingDefaultPolicy.id, (policy) => ({
          ...policy,
          action,
        }));
      } else {
        setDraftPolicies((prev) => [
          ...prev,
          {
            id: `draft-default-${Date.now()}`,
            toolId: tool.id,
            conditions: [],
            action,
            reason: null,
          },
        ]);
      }
      return;
    }

    callPolicyMutation.mutate({
      toolId: tool.id,
      action,
    });
  };

  const handlePolicyDelete = (policyId: string) => {
    if (mode === "historical") {
      setDraftPolicies((prev) => prev.filter((policy) => policy.id !== policyId));
      return;
    }

    toolInvocationPolicyDeleteMutation.mutate(policyId);
  };

  const handlePolicyActionUpdate = (
    policyId: string,
    action: ToolInvocationPolicyAction,
  ) => {
    if (mode === "historical") {
      setDraftPolicy(policyId, (policy) => ({ ...policy, action }));
      return;
    }

    toolInvocationPolicyUpdateMutation.mutate({
      id: policyId,
      action,
    });
  };

  const handlePolicyReasonUpdate = (policyId: string, reason: string) => {
    if (mode === "historical") {
      setDraftPolicy(policyId, (policy) => ({
        ...policy,
        reason: reason.length > 0 ? reason : null,
      }));
      return;
    }

    toolInvocationPolicyUpdateMutation.mutate({
      id: policyId,
      reason,
    });
  };

  const handleAddPolicy = () => {
    if (mode === "historical") {
      setDraftPolicies((prev) => [
        ...prev,
        {
          id: `draft-${Date.now()}-${prev.length}`,
          toolId: tool.id,
          conditions: [{ key: getDefaultConditionKey(), operator: "equal", value: "" }],
          action: "allow_when_context_is_untrusted",
          reason: null,
        },
      ]);
      return;
    }

    toolInvocationPolicyCreateMutation.mutate({
      toolId: tool.id,
      argumentName: getDefaultConditionKey(),
    });
  };

  return (
    <div className="border border-border rounded-lg p-6 bg-card space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold mb-1">Tool Call Policies</h3>
          <p className="text-sm text-muted-foreground">
            Controls when the tool can be called based on context trust level
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={mode === "current" ? "default" : "outline"}
            onClick={() => setModeAndSyncDraft("current")}
          >
            Current
          </Button>
          <Button
            size="sm"
            variant={mode === "historical" ? "default" : "outline"}
            onClick={() => setModeAndSyncDraft("historical")}
          >
            Historical Impact
          </Button>
        </div>
      </div>

      {mode === "historical" && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/40 p-3">
          <Badge variant="secondary">Draft</Badge>
          <span className="text-xs text-muted-foreground">
            Changes in this mode are local and not persisted.
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={runSimulation}
            disabled={simulatePoliciesMutation.isPending}
            className="ml-auto"
          >
            <FlaskConical className="w-3.5 h-3.5 mr-1" />
            {simulatePoliciesMutation.isPending
              ? "Running Simulation..."
              : "Run on Recent History"}
          </Button>
        </div>
      )}

      <div className="flex items-center justify-between p-3 bg-muted rounded-md border border-border">
        <div className="flex items-center gap-3">
          <div className="text-xs font-medium text-muted-foreground">
            DEFAULT
          </div>
        </div>
        <CallPolicyToggle
          value={currentAction}
          onChange={handleActionChange}
          size="lg"
        />
      </div>

      {policies.map((policy: (typeof allPolicies)[number]) => (
        <PolicyCard key={policy.id} onDelete={() => handlePolicyDelete(policy.id)}>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              {policy.conditions.map(
                (condition: PolicyCondition, index: number) => (
                  <div
                    key={`${condition.key}-${condition.operator}-${condition.value}`}
                    className="flex items-center gap-2"
                  >
                    <span className="text-sm text-muted-foreground w-2">
                      {index === 0 ? "If" : ""}
                    </span>
                    <ToolCallPolicyCondition
                      condition={condition}
                      conditionKeyOptions={{ argumentNames, contextOptions }}
                      removable={policy.conditions.length > 1}
                      onChange={(updated) =>
                        handleConditionChange(policy, index, updated)
                      }
                      onRemove={() => handleConditionRemove(policy, index)}
                    />
                    {index < policy.conditions.length - 1 ? (
                      <span className="text-sm text-muted-foreground">and</span>
                    ) : (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="secondary"
                              size="sm"
                              className="h-9 w-9 p-0"
                              aria-label="Add condition"
                              onClick={() => handleConditionAdd(policy)}
                            >
                              <Plus className="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>Add condition</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )}
                  </div>
                ),
              )}
            </div>
            <div className="flex items-center gap-2 pl-12">
              <ArrowRightIcon className="w-4 h-4 text-muted-foreground shrink-0" />
              <Select
                value={policy.action}
                onValueChange={
                  (value: ToolInvocationPolicyAction) =>
                    handlePolicyActionUpdate(policy.id, value)
                }
              >
                <SelectTrigger className="w-[200px]">
                  <SelectValue placeholder="Action" />
                </SelectTrigger>
                <SelectContent>
                  {policyOptionItems.map(({ value, label }) => (
                    <SelectItem
                      key={label}
                      value={value}
                      description={
                        value === "require_approval"
                          ? "Requires user confirmation before executing in chat. In autonomous agent sessions (A2A, API, MS Teams, subagents), the tool call is blocked."
                          : undefined
                      }
                    >
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <DebouncedInput
                placeholder="Reason"
                className="flex-1 min-w-[150px] max-w-[300px]"
                initialValue={policy.reason || ""}
                onChange={(value) => handlePolicyReasonUpdate(policy.id, value)}
              />
            </div>
          </div>
        </PolicyCard>
      ))}

      <ButtonWithTooltip
        variant="outline"
        className="w-full"
        onClick={handleAddPolicy}
        disabled={conditionKeyOptions.length === 0}
        disabledText="No parameters or context conditions available"
      >
        <Plus className="w-3.5 h-3.5 mr-1" /> Add Policy
      </ButtonWithTooltip>

      {mode === "historical" && simulationResult && (
        <div className="border border-border rounded-lg bg-muted/20 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold">Simulation Results</h4>
            <Badge variant="outline">
              {simulationResult.summary.totalCalls} calls analyzed
            </Badge>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-sm">
            <div className="rounded-md border border-border p-2">
              Newly blocked: {simulationResult.summary.newlyBlocked}
            </div>
            <div className="rounded-md border border-border p-2">
              Newly allowed: {simulationResult.summary.newlyAllowed}
            </div>
            <div className="rounded-md border border-border p-2">
              Approval added: {simulationResult.summary.requireApprovalAdded}
            </div>
            <div className="rounded-md border border-border p-2">
              Approval removed: {simulationResult.summary.requireApprovalRemoved}
            </div>
            <div className="rounded-md border border-border p-2">
              No change: {simulationResult.summary.noChange}
            </div>
          </div>
          <div className="space-y-2 max-h-72 overflow-auto pr-1">
            {simulationResult.details.map((detail) => (
              <div
                key={detail.mcpToolCallId}
                className="rounded-md border border-border bg-background p-2 text-xs"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium truncate">{detail.toolName}</span>
                  <Badge className={getOutcomeBadgeClass(detail.simulatedOutcome)}>
                    {detail.currentOutcome} to {detail.simulatedOutcome}
                  </Badge>
                </div>
                {detail.changedReason && (
                  <p className="mt-1 text-muted-foreground">{detail.changedReason}</p>
                )}
                <p className="mt-1 text-muted-foreground">{detail.calledAt}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
