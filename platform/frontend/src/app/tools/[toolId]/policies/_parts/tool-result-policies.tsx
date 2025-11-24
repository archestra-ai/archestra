"use client";

import type { archestraApiTypes } from "@shared";
import { Trash2 } from "lucide-react";
import { useCallback } from "react";
import type { TrustedDataPolicy } from "@/app/tools/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  useToolResultPoliciesDeleteMutation,
  useToolResultPoliciesUpdateMutation,
} from "@/lib/tool-policy.query";
import { ToolPolicyOperators } from "./tool-policy-operators";

interface ToolResultPoliciesProps {
  rules: TrustedDataPolicy[];
}

export function ToolResultPolicies({ rules }: ToolResultPoliciesProps) {
  const updateTrustedPolicy = useToolResultPoliciesUpdateMutation();
  const deleteTrustedPolicy = useToolResultPoliciesDeleteMutation();

  const handleUpdateTrustedPolicy = useCallback(
    (id: string, data: Partial<TrustedDataPolicy>) => {
      updateTrustedPolicy.mutate({ id, ...data });
    },
    [updateTrustedPolicy],
  );

  const handleDeleteTrustedPolicy = useCallback(
    (id: string) => {
      deleteTrustedPolicy.mutate(id);
    },
    [deleteTrustedPolicy],
  );

  return (
    <div className="space-y-3">
      {rules.length === 0 ? (
        <p className="text-sm text-muted-foreground">No result policies.</p>
      ) : (
        <div className="space-y-3">
          {rules.map((rule) => (
            <div key={rule.id} className="rounded-md border p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Input
                  defaultValue={rule.attributePath}
                  placeholder="attribute path"
                  onBlur={(event) =>
                    handleUpdateTrustedPolicy(rule.id, {
                      attributePath: event.currentTarget.value,
                    })
                  }
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleDeleteTrustedPolicy(rule.id)}
                >
                  <Trash2 className="h-4 w-4 text-muted-foreground" />
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <ToolPolicyOperators
                  value={rule.operator}
                  onChange={(value) =>
                    handleUpdateTrustedPolicy(rule.id, {
                      operator:
                        value as archestraApiTypes.CreateTrustedDataPolicyData["body"]["operator"],
                    })
                  }
                />
                <Select
                  defaultValue={rule.action}
                  onValueChange={(value) =>
                    handleUpdateTrustedPolicy(rule.id, {
                      action:
                        value as archestraApiTypes.CreateTrustedDataPolicyData["body"]["action"],
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Action" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="mark_as_trusted">
                      Mark as trusted
                    </SelectItem>
                    <SelectItem value="mark_as_untrusted">
                      Mark as untrusted
                    </SelectItem>
                    <SelectItem value="block_always">Block always</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Input
                defaultValue={rule.value ?? ""}
                placeholder="Value to match"
                onBlur={(event) =>
                  handleUpdateTrustedPolicy(rule.id, {
                    value: event.currentTarget.value,
                  })
                }
              />
              <Textarea
                defaultValue={rule.description ?? ""}
                placeholder="Description (optional)"
                onBlur={(event) =>
                  handleUpdateTrustedPolicy(rule.id, {
                    description: event.currentTarget.value,
                  })
                }
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
