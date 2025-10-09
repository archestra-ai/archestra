import type {
  GetToolsResponse,
  GetTrustedDataPoliciesResponse,
} from "@shared/api-client";
import { toPath } from "lodash-es";
import { ArrowRightIcon, Plus, Trash2Icon } from "lucide-react";
import { DebouncedInput } from "@/components/debounced-input";
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
import { useToolPatchMutation } from "@/lib/tool.query";
import { PolicyCard } from "./policy-card";

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
  const policies = byToolId[tool.id] || [];
  const toolResultPoliciesUpdateMutation =
    useToolResultPoliciesUpdateMutation();
  const toolResultPoliciesDeleteMutation =
    useToolResultPoliciesDeleteMutation();
  const toolPatchMutation = useToolPatchMutation();

  return (
    <div className="border border-border rounded-lg p-6 bg-card space-y-4">
      <div className="flex flex-row items-start justify-between">
        <div>
          <h3 className="text-sm font-semibold mb-1">Tool Result Policies</h3>
          <p className="text-xs text-muted-foreground">
            Configure trust levels for outputs
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
        </div>
      </div>
      {policies.map((policy) => (
        <PolicyCard key={policy.id}>
          <div className="flex flex-row gap-4 justify-between w-full">
            <div className="flex flex-row items-center gap-4">
              If
              <DebouncedInput
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
