import type { archestraApiTypes } from "@shared";
import { toPath } from "lodash-es";
import { ArrowRightIcon, Plus, Trash2Icon } from "lucide-react";
import { CodeText } from "@/components/code-text";
import { DebouncedInput } from "@/components/debounced-input";
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
  useOperators,
  useToolResultPolicies,
  useToolResultPoliciesCreateMutation,
  useToolResultPoliciesDeleteMutation,
  useToolResultPoliciesUpdateMutation,
} from "@/lib/policy.query";
import { PolicyCard } from "./policy-card";

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

type ResultPolicyCondition =
  archestraApiTypes.GetTrustedDataPoliciesResponses["200"][number]["conditions"][number];

export function ToolResultPolicies({
  agentTool,
}: {
  agentTool: archestraApiTypes.GetAllAgentToolsResponses["200"]["data"][number];
}) {
  const toolResultPoliciesCreateMutation =
    useToolResultPoliciesCreateMutation();
  const {
    data: { byToolId },
  } = useToolResultPolicies();
  const { data: operators } = useOperators();
  // Policies are now per-tool, not per-agent-tool
  const policies = byToolId[agentTool.tool.id] || [];
  const toolResultPoliciesUpdateMutation =
    useToolResultPoliciesUpdateMutation();
  const toolResultPoliciesDeleteMutation =
    useToolResultPoliciesDeleteMutation();

  // Find default policy (empty conditions) and specific policies (non-empty conditions)
  const defaultPolicy = policies.find((p) => p.conditions.length === 0);
  const specificPolicies = policies.filter((p) => p.conditions.length > 0);

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
      {defaultPolicy && (
        <div className="flex items-center justify-between p-3 bg-muted/50 rounded-md border border-border">
          <div className="flex items-center gap-3">
            <div className="text-xs font-medium text-muted-foreground">
              DEFAULT
            </div>
            <Select
              value={defaultPolicy.action}
              onValueChange={(
                value: "mark_as_trusted" | "sanitize_with_dual_llm" | "block_always",
              ) => {
                toolResultPoliciesUpdateMutation.mutate({
                  id: defaultPolicy.id,
                  action: value,
                });
              }}
            >
              <SelectTrigger className="w-[220px]">
                <SelectValue placeholder="Select treatment" />
              </SelectTrigger>
              <SelectContent>
                {TOOL_RESULT_ACTION_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}
      {specificPolicies.map((policy) => (
        <PolicyCard key={policy.id}>
          <div className="flex flex-col gap-2 w-full">
            {/* Render each condition */}
            {policy.conditions.map((condition, conditionIndex) => (
              <div
                key={conditionIndex}
                className="flex flex-row items-center gap-4 justify-between"
              >
                <div className="flex flex-row items-center gap-4">
                  {conditionIndex === 0 ? "If" : "AND"}
                  <DebouncedInput
                    placeholder="Attribute path"
                    initialValue={condition.key}
                    onChange={(key) => {
                      const newConditions = [...policy.conditions];
                      newConditions[conditionIndex] = { ...condition, key };
                      toolResultPoliciesUpdateMutation.mutate({
                        id: policy.id,
                        conditions: newConditions,
                      });
                    }}
                  />
                  {!isValidPathSyntax(condition.key) && (
                    <span className="text-red-500 text-sm">Invalid path</span>
                  )}
                  <Select
                    defaultValue={condition.operator}
                    onValueChange={(
                      value: ResultPolicyCondition["operator"],
                    ) => {
                      const newConditions = [...policy.conditions];
                      newConditions[conditionIndex] = {
                        ...condition,
                        operator: value,
                      };
                      toolResultPoliciesUpdateMutation.mutate({
                        id: policy.id,
                        conditions: newConditions,
                      });
                    }}
                  >
                    <SelectTrigger className="w-[180px]">
                      <SelectValue placeholder="Operator" />
                    </SelectTrigger>
                    <SelectContent>
                      {operators.map((operator) => (
                        <SelectItem key={operator.value} value={operator.value}>
                          {operator.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <DebouncedInput
                    placeholder="Value"
                    initialValue={condition.value}
                    onChange={(value) => {
                      const newConditions = [...policy.conditions];
                      newConditions[conditionIndex] = { ...condition, value };
                      toolResultPoliciesUpdateMutation.mutate({
                        id: policy.id,
                        conditions: newConditions,
                      });
                    }}
                  />
                </div>
                {policy.conditions.length > 1 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="hover:text-red-500"
                    onClick={() => {
                      const newConditions = policy.conditions.filter(
                        (_, i) => i !== conditionIndex,
                      );
                      toolResultPoliciesUpdateMutation.mutate({
                        id: policy.id,
                        conditions: newConditions,
                      });
                    }}
                  >
                    <Trash2Icon className="w-4 h-4" />
                  </Button>
                )}
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-2 pl-4 justify-between">
              <div className="flex items-center gap-2">
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
                    {TOOL_RESULT_ACTION_OPTIONS.map(({ value, label }) => (
                      <SelectItem key={label} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    toolResultPoliciesUpdateMutation.mutate({
                      id: policy.id,
                      conditions: [
                        ...policy.conditions,
                        { key: "", operator: "equal", value: "" },
                      ],
                    });
                  }}
                >
                  <Plus className="w-3.5 h-3.5 mr-1" /> Add Condition
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="hover:text-red-500"
                  onClick={() =>
                    toolResultPoliciesDeleteMutation.mutate(policy.id)
                  }
                >
                  <Trash2Icon className="w-4 h-4" />
                </Button>
              </div>
            </div>
          </div>
        </PolicyCard>
      ))}
      <Button
        variant="outline"
        className="w-full"
        onClick={() =>
          toolResultPoliciesCreateMutation.mutate({ toolId: agentTool.tool.id })
        }
      >
        <Plus className="w-3.5 h-3.5 mr-1" /> Add Tool Result Policy
      </Button>
      {specificPolicies.length > 0 && <AttributePathExamples />}
    </div>
  );
}

const TOOL_RESULT_ACTION_OPTIONS = [
  { value: "mark_as_trusted", label: "Mark as trusted" },
  { value: "block_always", label: "Block always" },
  { value: "sanitize_with_dual_llm", label: "Sanitize with Dual LLM" },
] as const;

function isValidPathSyntax(path: string): boolean {
  const segments = toPath(path);
  // reject empty segments like "a..b"
  return segments.every((seg) => seg.length > 0);
}
