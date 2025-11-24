"use client";

import type { archestraApiTypes } from "@shared";
import { Trash2 } from "lucide-react";
import { useCallback } from "react";
import type { ToolInvocationPolicy } from "@/app/tools/types";
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
  useToolInvocationPolicyDeleteMutation,
  useToolInvocationPolicyUpdateMutation,
} from "@/lib/tool-policy.query";
import { ToolPolicyOperators } from "./tool-policy-operators";

interface ToolInvocationPoliciesProps {
  rules: ToolInvocationPolicy[];
}

export function ToolInvocationPolicies({ rules }: ToolInvocationPoliciesProps) {
  const updateInvocationPolicy = useToolInvocationPolicyUpdateMutation();
  const deleteInvocationPolicy = useToolInvocationPolicyDeleteMutation();

  const handleUpdateInvocationPolicy = useCallback(
    (id: string, data: Partial<ToolInvocationPolicy>) => {
      updateInvocationPolicy.mutate({ id, ...data });
    },
    [updateInvocationPolicy],
  );

  const handleDeleteInvocationPolicy = useCallback(
    (id: string) => {
      deleteInvocationPolicy.mutate(id);
    },
    [deleteInvocationPolicy],
  );

  return (
    <div className="space-y-3">
      {rules.length === 0 ? (
        <p className="text-sm text-muted-foreground">No invocation rules.</p>
      ) : (
        <div className="space-y-3">
          {rules.map((rule) => (
            <div key={rule.id} className="rounded-md border p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Input
                  defaultValue={rule.argumentName}
                  placeholder="argument path"
                  onBlur={(event) =>
                    handleUpdateInvocationPolicy(rule.id, {
                      argumentName: event.currentTarget.value,
                    })
                  }
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleDeleteInvocationPolicy(rule.id)}
                >
                  <Trash2 className="h-4 w-4 text-muted-foreground" />
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <ToolPolicyOperators
                  value={rule.operator as string}
                  onChange={(value) =>
                    handleUpdateInvocationPolicy(rule.id, {
                      operator:
                        value as archestraApiTypes.CreateToolInvocationPolicyData["body"]["operator"],
                    })
                  }
                />
                <Select
                  defaultValue={rule.action}
                  onValueChange={(value) =>
                    handleUpdateInvocationPolicy(rule.id, {
                      action:
                        value as archestraApiTypes.CreateToolInvocationPolicyData["body"]["action"],
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Action" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="allow_when_context_is_untrusted">
                      Allow when context untrusted
                    </SelectItem>
                    <SelectItem value="block_always">Block always</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Input
                defaultValue={rule.value}
                placeholder="Value to match"
                onBlur={(event) =>
                  handleUpdateInvocationPolicy(rule.id, {
                    value: event.currentTarget.value,
                  })
                }
              />
              <Textarea
                defaultValue={rule.reason ?? ""}
                placeholder="Reason (optional)"
                onBlur={(event) =>
                  handleUpdateInvocationPolicy(rule.id, {
                    reason: event.currentTarget.value,
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
