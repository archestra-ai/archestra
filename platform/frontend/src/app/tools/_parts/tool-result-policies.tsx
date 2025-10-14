import { toPath } from "lodash-es";
import { ArrowRightIcon, Plus, Trash2Icon } from "lucide-react";
import Link from "next/link";
import { DebouncedInput } from "@/components/debounced-input";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  GetToolsResponse,
  GetTrustedDataPoliciesResponse,
} from "@/lib/clients/api";
import { useDualLlmConfig } from "@/lib/dual-llm-config.query";
import {
  useOperators,
  useToolResultPolicies,
  useToolResultPoliciesCreateMutation,
  useToolResultPoliciesDeleteMutation,
  useToolResultPoliciesUpdateMutation,
} from "@/lib/policy.query";
import { useToolPatchMutation } from "@/lib/tool.query";
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
            Attribute Path Syntax Examples
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
              <code className="bg-muted px-1 py-0.5 rounded">*</code> as a
              wildcard to match all items in an array.
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
                      <code className="bg-muted px-1 py-0.5 rounded">
                        location
                      </code>{" "}
                      → <span className="text-foreground">"San Francisco"</span>
                    </li>
                    <li>
                      <code className="bg-muted px-1 py-0.5 rounded">
                        current.temperature
                      </code>{" "}
                      → <span className="text-foreground">72</span>
                    </li>
                    <li>
                      <code className="bg-muted px-1 py-0.5 rounded">
                        current.conditions
                      </code>{" "}
                      → <span className="text-foreground">"Sunny"</span>
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
                      <code className="bg-muted-px-1 py-0.5 rounded">
                        emails[*].from
                      </code>{" "}
                      → Matches all "from" fields in the emails array
                    </li>
                    <li>
                      <code className="bg-muted px-1 py-0.5 rounded">
                        emails[0].from
                      </code>{" "}
                      →{" "}
                      <span className="text-foreground">
                        "alice@company.com"
                      </span>
                    </li>
                    <li>
                      <code className="bg-muted px-1 py-0.5 rounded">
                        emails[*].body
                      </code>{" "}
                      → Matches all "body" fields in the emails array
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

export function ToolResultPolicies({
  tool,
}: {
  tool: GetToolsResponse["200"];
}) {
  const toolResultPoliciesCreateMutation =
    useToolResultPoliciesCreateMutation();
  const {
    data: { byToolId },
  } = useToolResultPolicies();
  const { data: operators } = useOperators();
  const { data: dualLlmConfig } = useDualLlmConfig();
  const policies = byToolId[tool.id] || [];
  const toolResultPoliciesUpdateMutation =
    useToolResultPoliciesUpdateMutation();
  const toolResultPoliciesDeleteMutation =
    useToolResultPoliciesDeleteMutation();
  const toolPatchMutation = useToolPatchMutation();

  // Determine if Dual LLM will be triggered based on the default action
  const isDualLlmEnabled = dualLlmConfig?.enabled ?? false;
  const willTriggerDualLlm = !tool.dataIsTrustedByDefault && isDualLlmEnabled;

  return (
    <div className="border border-border rounded-lg p-6 bg-card space-y-4">
      <div className="flex flex-col gap-4">
        <div className="flex flex-row items-start justify-between">
          <div>
            <h3 className="text-sm font-semibold mb-1">Tool Result Policies</h3>
            <p className="text-sm text-muted-foreground">
              Control which data from tool results is marked as trusted or
              blocked.
              <br />
              <br />
              By default, all data returned by tools is marked as "untrusted"
              unless you configure it otherwise. Trusted Data Policies let you:
            </p>
            <ul className="text-sm text-muted-foreground">
              <li>• Mark tool results as trusted/untrusted by default</li>
              <li>
                • Mark data as trusted based on the values of specific fields in
                tool responses
              </li>
              <li>
                • Block specific data from ever reaching the LLM entirely
                (filtered before being sent to the LLM)
              </li>
            </ul>
            <p className="text-sm text-muted-foreground mt-2">
              This is part of Archestra's{" "}
              <a
                href="https://www.archestra.ai/docs/platform-dynamic-tools"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-foreground"
              >
                Dynamic Tools
              </a>{" "}
              security system, which adapts agent capabilities based on data
              trust levels to prevent lethal-trifecta attacks.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            onClick={() =>
              toolResultPoliciesCreateMutation.mutate({ toolId: tool.id })
            }
          >
            <Plus className="w-3.5 h-3.5" /> Add
          </Button>
        </div>

        <AttributePathExamples />
      </div>
      <div className="flex items-center justify-between p-3 bg-muted/50 rounded-md border border-border">
        <div className="flex items-center gap-3">
          <div className="text-xs font-medium text-muted-foreground">
            DEFAULT
          </div>
          <Select
            defaultValue={tool.dataIsTrustedByDefault ? "true" : "false"}
            onValueChange={(value) => {
              toolPatchMutation.mutate({
                id: tool.id,
                dataIsTrustedByDefault: value === "true",
              });
            }}
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="parameter" />
            </SelectTrigger>
            <SelectContent>
              {DEFAULT_TRUSTED_UNTRUSTED_SELECT_OPTIONS.map((val) => (
                <SelectItem key={val.label} value={val.value.toString()}>
                  {val.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {willTriggerDualLlm ? (
            <Badge variant="default" asChild>
              <Link href="/dual-llm" className="cursor-pointer">
                Dual LLM is active
              </Link>
            </Badge>
          ) : (
            <Badge variant="secondary" asChild>
              <Link href="/dual-llm" className="cursor-pointer">
                Dual LLM is inactive (Click to enable)
              </Link>
            </Badge>
          )}
        </div>
      </div>
      {policies.map((policy) => (
        <PolicyCard key={policy.id}>
          <div className="flex flex-row gap-4 justify-between w-full">
            <div className="flex flex-row items-center gap-4">
              If
              <DebouncedInput
                placeholder="Attribute path"
                initialValue={policy.attributePath}
                onChange={(attributePath) =>
                  toolResultPoliciesUpdateMutation.mutate({
                    ...policy,
                    attributePath,
                  })
                }
              />
              {!isValidPathSyntax(policy.attributePath) && (
                <span className="text-red-500 text-sm">Invalid path</span>
              )}
              <Select
                defaultValue={policy.operator}
                onValueChange={(
                  value: GetTrustedDataPoliciesResponse["200"]["operator"],
                ) =>
                  toolResultPoliciesUpdateMutation.mutate({
                    ...policy,
                    operator: value,
                  })
                }
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
                initialValue={policy.value}
                onChange={(value) =>
                  toolResultPoliciesUpdateMutation.mutate({
                    ...policy,
                    value,
                  })
                }
              />
              <ArrowRightIcon className="w-4 h-4 shrink-0" />
              <Select
                defaultValue={policy.action}
                onValueChange={(
                  value: GetTrustedDataPoliciesResponse["200"]["action"],
                ) =>
                  toolResultPoliciesUpdateMutation.mutate({
                    ...policy,
                    action: value,
                  })
                }
              >
                <SelectTrigger className="w-[240px]">
                  <SelectValue placeholder="Allowed for" />
                </SelectTrigger>
                <SelectContent>
                  {[
                    {
                      value: "mark_as_trusted",
                      label: "Mark as trusted",
                    },
                    { value: "block_always", label: "Block always" },
                  ].map(({ value, label }) => (
                    <SelectItem key={label} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="hover:text-red-500"
              onClick={() => toolResultPoliciesDeleteMutation.mutate(policy.id)}
            >
              <Trash2Icon />
            </Button>
          </div>
        </PolicyCard>
      ))}
    </div>
  );
}

const DEFAULT_TRUSTED_UNTRUSTED_SELECT_OPTIONS = [
  { value: true, label: "Mark as trusted" },
  { value: false, label: "Mark as untrusted" },
];

function isValidPathSyntax(path: string): boolean {
  const segments = toPath(path);
  // reject empty segments like "a..b"
  return segments.every((seg) => seg.length > 0);
}
