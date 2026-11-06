"use client";

import { useEffect, useRef, useState } from "react";
import { NetworkPolicyFields } from "@/components/network-policy-fields";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  type EnvironmentWithAssignedCount,
  useK8sCapabilities,
} from "@/lib/environment.query";

type NetworkPolicy = NonNullable<EnvironmentWithAssignedCount["networkPolicy"]>;

/**
 * An agent's own egress policy for its Agent Runtime and code sandbox, or
 * nothing to inherit its environment's. Only someone who may edit
 * environment policies can change it, because it overrides one.
 */
export function AgentNetworkPolicyField({
  value,
  onChange,
  disabled,
}: {
  value: NetworkPolicy | null;
  onChange: (value: NetworkPolicy | null) => void;
  disabled: boolean;
}) {
  const { data: canUpdateEnvironments } = useHasPermissions({
    environment: ["update"],
  });
  const { data: capabilities } = useK8sCapabilities();
  // The textareas keep what was typed (blank lines, a half-typed entry); the
  // policy handed up is the parsed list.
  const [domainsText, setDomainsText] = useState(
    value?.allowedDomains.join("\n") ?? "",
  );
  const [cidrsText, setCidrsText] = useState(
    value?.allowedCidrs.join("\n") ?? "",
  );
  // Reseed when the form loads or resets to another policy, but not on the
  // echo of this field's own edit, which would eat a just-typed newline.
  const valueKey = JSON.stringify(value);
  const emittedKey = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reseed on an outside value change only
  useEffect(() => {
    if (valueKey === emittedKey.current) return;
    setDomainsText(value?.allowedDomains.join("\n") ?? "");
    setCidrsText(value?.allowedCidrs.join("\n") ?? "");
  }, [valueKey]);

  const locked = disabled || canUpdateEnvironments !== true;
  const emit = (next: NetworkPolicy | null) => {
    emittedKey.current = JSON.stringify(next);
    onChange(next);
  };
  const update = (patch: Partial<NetworkPolicy>) => {
    if (!value) return;
    emit({ ...value, ...patch });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="agent-network-policy-source">Policy</Label>
        <Select
          value={value ? "custom" : "inherit"}
          onValueChange={(next) =>
            emit(next === "custom" ? (value ?? DEFAULT_CUSTOM_POLICY) : null)
          }
          disabled={locked}
        >
          <SelectTrigger id="agent-network-policy-source" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem
              value="inherit"
              description="Follow the policy of the agent's environment, or the organization default."
            >
              Inherit from environment
            </SelectItem>
            <SelectItem
              value="custom"
              description="Give this agent its own policy, replacing its environment's."
            >
              Custom for this agent
            </SelectItem>
          </SelectContent>
        </Select>
        {canUpdateEnvironments === false && (
          <p className="text-xs text-muted-foreground">
            Changing it requires permission to update environments.
          </p>
        )}
      </div>
      {value && (
        <NetworkPolicyFields
          egressMode={value.egressMode}
          setEgressMode={(egressMode) => update({ egressMode })}
          domainPreset={value.domainPreset}
          setDomainPreset={(domainPreset) => update({ domainPreset })}
          allowedDomainsText={domainsText}
          setAllowedDomainsText={(text) => {
            setDomainsText(text);
            update({ allowedDomains: parseLines(text) });
          }}
          allowedCidrsText={cidrsText}
          setAllowedCidrsText={(text) => {
            setCidrsText(text);
            update({ allowedCidrs: parseLines(text) });
          }}
          supportsFqdn={capabilities?.networkPolicy.supportsFqdn === true}
          enforcementStatus={
            capabilities?.networkPolicy.enforcementStatus ?? null
          }
          baselineLoaded={true}
          disabled={locked}
        />
      )}
    </div>
  );
}

// A new custom policy starts locked down; the editor opens it up.
const DEFAULT_CUSTOM_POLICY: NetworkPolicy = {
  egressMode: "restricted",
  domainPreset: "none",
  allowedDomains: [],
  allowedCidrs: [],
};

function parseLines(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,]/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}
