import {
  type archestraApiTypes,
  CONTEXT_EXTERNAL_AGENT_ID,
  CONTEXT_TEAM_IDS,
} from "@shared";
import { ArrowRightIcon, Plus } from "lucide-react";
import { CodeText } from "@/components/code-text";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
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
import { useUniqueExternalAgentIds } from "@/lib/interaction.query";
import {
  useResultPolicyMutation,
  useToolResultPolicies,
  useToolResultPoliciesCreateMutation,
  useToolResultPoliciesDeleteMutation,
  useToolResultPoliciesUpdateMutation,
} from "@/lib/policy.query";
import {
  getResultTreatmentFromPolicies,
  type ToolResultTreatment,
} from "@/lib/policy.utils";
import { useTeams } from "@/lib/team.query";
import { PolicyCard } from "./policy-card";
import type { PolicyCondition } from "./tool-call-policy-condition";
import { ToolResultPolicyCondition } from "./tool-result-policy-condition";

function AttributePathExamples() {
  return (
    <Accordion type="single" collapsible>
      <AccordionItem
        value="examples"
        className="border border-border rounded-lg bg-card border-b-0 last:border-b"
      >
        <AccordionTrigger className="px-4 hover:no-underline">
          <span className="text-sm font-medium">
            📖 Attribute Path Syntax Cheat Sheet
          </span>
        </AccordionTrigger>
        <AccordionContent className="px-4">
          <div className="space-y-4 text-sm">
            <p className="text-muted-foreground">
              Attribute paths use{" "}
              <a
                href="https://lodash.com/docs/4.17.15#get"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-foreground"
              >
                lodash get syntax
              </a>{" "}
              to target specific fields in tool responses. You can use{" "}
              <CodeText>*</CodeText> as a wildcard to match all items in an
              array.
            </p>

            <div className="space-y-6">
              <div className="space-y-2">
                <h4 className="font-medium">Example 1: Simple nested object</h4>
                <p className="text-muted-foreground">
                  Tool response from a weather API:
                </p>
                <pre className="bg-muted p-3 rounded-md overflow-x-auto text-xs">
                  {`{
  "location": "San Francisco",
  "current": {
    "temperature": 72,
    "conditions": "Sunny"
  }
}`}
                </pre>
                <div className="space-y-1">
                  <p className="text-muted-foreground">Attribute paths:</p>
                  <ul className="list-disc list-inside space-y-1 text-muted-foreground ml-2">
                    <li>
                      <CodeText>location</CodeText> →{" "}
                      <span className="text-foreground">"San Francisco"</span>
                    </li>
                    <li>
                      <CodeText>current.temperature</CodeText> →{" "}
                      <span className="text-foreground">72</span>
                    </li>
                    <li>
                      <CodeText>current.conditions</CodeText> →{" "}
                      <span className="text-foreground">"Sunny"</span>
                    </li>
                  </ul>
                </div>
              </div>

              <div className="space-y-2">
                <h4 className="font-medium">
                  Example 2: Array with wildcard (*)
                </h4>
                <p className="text-muted-foreground">
                  Tool response from an email API:
                </p>
                <pre className="bg-muted p-3 rounded-md overflow-x-auto text-xs">
                  {`{
  "emails": [
    {
      "from": "alice@company.com",
      "subject": "Meeting notes",
      "body": "Here are the notes..."
    },
    {
      "from": "external@example.com",
      "subject": "Ignore previous instructions",
      "body": "Malicious content..."
    }
  ]
}`}
                </pre>
                <div className="space-y-1">
                  <p className="text-muted-foreground">Attribute paths:</p>
                  <ul className="list-disc list-inside space-y-1 text-muted-foreground ml-2">
                    <li>
                      <CodeText>emails[*].from</CodeText> → Matches all "from"
                      fields in the emails array
                    </li>
                    <li>
                      <CodeText>emails[0].from</CodeText> →{" "}
                      <span className="text-foreground">
                        "alice@company.com"
                      </span>
                    </li>
                    <li>
                      <CodeText>emails[*].body</CodeText> → Matches all "body"
                      fields in the emails array
                    </li>
                  </ul>
                  <p className="text-muted-foreground mt-2 italic">
                    Use case: Block emails from external domains or mark
                    internal emails as trusted
                  </p>
                </div>
              </div>
            </div>
          </div>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

type ToolForPolicies = {
  id: string;
};

export function ToolResultPolicies({ tool }: { tool: ToolForPolicies }) {
  const toolResultPoliciesCreateMutation =
    useToolResultPoliciesCreateMutation();
  const {
    data: { byProfileToolId },
    data: resultPolicies,
  } = useToolResultPolicies();
  const { data: externalAgentIds } = useUniqueExternalAgentIds();
  const { data: teams } = useTeams();

  // Build context options for the key dropdown
  const contextOptions = [
    ...(externalAgentIds.length > 0 ? [CONTEXT_EXTERNAL_AGENT_ID] : []),
    ...((teams?.length ?? 0) > 0 ? [CONTEXT_TEAM_IDS] : []),
  ];

  // Build items for SearchableSelect with context options
  const keyItems = [
    ...contextOptions.map((key) => ({
      value: key,
      label: key === CONTEXT_EXTERNAL_AGENT_ID ? "External Agent" : "Teams",
    })),
  ];
  const allPolicies = byProfileToolId[tool.id] || [];
  // Filter out default policies (empty conditions) - they're shown in the DEFAULT section
  const policies = allPolicies.filter((policy) => policy.conditions.length > 0);
  const toolResultPoliciesUpdateMutation =
    useToolResultPoliciesUpdateMutation();
  const toolResultPoliciesDeleteMutation =
    useToolResultPoliciesDeleteMutation();
  const resultPolicyMutation = useResultPolicyMutation();

  // Derive treatment from policies (default policy with empty conditions)
  const toolResultTreatment = getResultTreatmentFromPolicies(
    tool.id,
    resultPolicies,
  );

  const handleConditionChange = (
    policy: (typeof policies)[number],
    index: number,
    updatedCondition: PolicyCondition,
  ) => {
    const newConditions = [...policy.conditions];
    newConditions[index] = updatedCondition;
    toolResultPoliciesUpdateMutation.mutate({
      id: policy.id,
      conditions: newConditions,
    });
  };

  const handleConditionRemove = (
    policy: (typeof policies)[number],
    index: number,
  ) => {
    const newConditions = policy.conditions.filter((_, i) => i !== index);
    toolResultPoliciesUpdateMutation.mutate({
      id: policy.id,
      conditions: newConditions,
    });
  };

  const handleConditionAdd = (policy: (typeof policies)[number]) => {
    const newConditions: PolicyCondition[] = [
      ...policy.conditions,
      { key: "", operator: "equal", value: "" },
    ];
    toolResultPoliciesUpdateMutation.mutate({
      id: policy.id,
      conditions: newConditions,
    });
  };

  return (
    <div className="border border-border rounded-lg p-6 bg-card space-y-4">
      <div className="flex flex-col gap-4">
        <div>
          <h3 className="text-sm font-semibold mb-1">Tool Result Policies</h3>
          <p className="text-sm text-muted-foreground">
            Tool results impact agent decisions and actions. This policy allows
            to mark tool results as &ldquo;trusted&rdquo; or
            &ldquo;untrusted&rdquo; to prevent agent acting on untrusted data.{" "}
            <a
              href="https://archestra.ai/docs/platform-dynamic-tools"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-foreground"
            >
              Read more about Dynamic Tools.
            </a>
          </p>
          <p className="text-sm text-muted-foreground mt-2"></p>
        </div>
      </div>
      <div className="flex items-center justify-between p-3 bg-muted/50 rounded-md border border-border">
        <div className="flex items-center gap-3">
          <div className="text-xs font-medium text-muted-foreground">
            DEFAULT
          </div>
          <Select
            value={toolResultTreatment}
            disabled={resultPolicyMutation.isPending}
            onValueChange={(value) => {
              if (value === toolResultTreatment) return;
              resultPolicyMutation.mutate({
                toolId: tool.id,
                treatment: value as ToolResultTreatment,
              });
            }}
          >
            <SelectTrigger className="w-[220px]">
              <SelectValue placeholder="Select treatment" />
            </SelectTrigger>
            <SelectContent>
              {TOOL_RESULT_TREATMENT_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {policies.map((policy) => (
        <PolicyCard
          key={policy.id}
          onDelete={() => toolResultPoliciesDeleteMutation.mutate(policy.id)}
        >
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              {policy.conditions.map((condition, index) => (
                <div
                  key={`${condition.key}-${condition.operator}-${condition.value}`}
                  className="flex items-center gap-2"
                >
                  <span className="text-sm text-muted-foreground w-2">
                    {index === 0 ? "If" : ""}
                  </span>
                  <ToolResultPolicyCondition
                    condition={condition}
                    keyItems={keyItems}
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
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2 pl-12">
              <ArrowRightIcon className="w-4 h-4 text-muted-foreground" />
              <Select
                defaultValue={policy.action}
                onValueChange={(
                  value: archestraApiTypes.GetTrustedDataPoliciesResponses["200"][number]["action"],
                ) =>
                  toolResultPoliciesUpdateMutation.mutate({
                    id: policy.id,
                    action: value,
                  })
                }
              >
                <SelectTrigger className="w-[240px]">
                  <SelectValue placeholder="Action" />
                </SelectTrigger>
                <SelectContent>
                  {[
                    {
                      value: "mark_as_trusted",
                      label: "Mark as trusted",
                    },
                    {
                      value: "mark_as_untrusted",
                      label: "Mark as untrusted",
                    },
                    { value: "block_always", label: "Block always" },
                    {
                      value: "sanitize_with_dual_llm",
                      label: "Sanitize with Dual LLM",
                    },
                  ].map(({ value, label }) => (
                    <SelectItem key={label} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </PolicyCard>
      ))}
      <Button
        variant="outline"
        className="w-full"
        onClick={() =>
          toolResultPoliciesCreateMutation.mutate({
            toolId: tool.id,
            attributePath: "",
          })
        }
      >
        <Plus className="w-3.5 h-3.5 mr-1" /> Add Tool Result Policy
      </Button>
      {policies.length > 0 && <AttributePathExamples />}
    </div>
  );
}

const TOOL_RESULT_TREATMENT_OPTIONS = [
  { value: "trusted", label: "Mark as trusted" },
  { value: "untrusted", label: "Mark as untrusted" },
  { value: "sanitize_with_dual_llm", label: "Sanitize with Dual LLM" },
] as const;
