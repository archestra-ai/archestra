"use client";

import Link from "next/link";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useNetworkPolicies } from "@/lib/organization/network-policy.query";

const NETWORK_POLICY_DEFAULT_VALUE = "__default_network_policy__";

export function InstallNetworkPolicySelect({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  const { data: networkPolicies = [] } = useNetworkPolicies();

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label>Network Policy</Label>
        <Link
          href="/mcp/registry/network-policies"
          className="text-xs text-primary hover:underline"
        >
          Manage policies
        </Link>
      </div>
      <Select
        value={value ?? NETWORK_POLICY_DEFAULT_VALUE}
        onValueChange={(nextValue) =>
          onChange(
            nextValue === NETWORK_POLICY_DEFAULT_VALUE ? null : nextValue,
          )
        }
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NETWORK_POLICY_DEFAULT_VALUE}>
            Use catalog/environment default
          </SelectItem>
          {networkPolicies.map((policy) => (
            <SelectItem
              key={policy.id}
              value={policy.id}
              description={policy.description ?? undefined}
            >
              {policy.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
