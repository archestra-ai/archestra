"use client";

import { DocsPage, getDocsUrl } from "@archestra/shared";
import { Info, TriangleAlert } from "lucide-react";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { FieldDescription } from "@/components/ui/field-description";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { EnvironmentWithAssignedCount } from "@/lib/environment.query";

type NetworkPolicy = NonNullable<EnvironmentWithAssignedCount["networkPolicy"]>;
type EgressMode = NetworkPolicy["egressMode"];
type DomainPreset = NetworkPolicy["domainPreset"];

/**
 * The egress controls of a network policy: mode, CIDRs, domain preset and
 * domains. Shared by the environment editor and an agent's own policy.
 */
export function NetworkPolicyFields({
  egressMode,
  setEgressMode,
  domainPreset,
  setDomainPreset,
  allowedDomainsText,
  setAllowedDomainsText,
  allowedCidrsText,
  setAllowedCidrsText,
  supportsFqdn,
  enforcementStatus,
  baselineLoaded,
  disabled,
}: {
  egressMode: EgressMode;
  setEgressMode: (value: EgressMode) => void;
  domainPreset: DomainPreset;
  setDomainPreset: (value: DomainPreset) => void;
  allowedDomainsText: string;
  setAllowedDomainsText: (value: string) => void;
  allowedCidrsText: string;
  setAllowedCidrsText: (value: string) => void;
  supportsFqdn: boolean;
  enforcementStatus:
    | "verified-enforced"
    | "verified-not-enforced"
    | "unknown"
    | null;
  baselineLoaded: boolean;
  disabled: boolean;
}) {
  // A probe watched a deny-all policy fail to stop a packet: every rule below
  // would be accepted and never enforced, so the section is disabled rather
  // than offering controls that silently do nothing.
  const enforcementUnavailable = enforcementStatus === "verified-not-enforced";
  // Nothing measured this cluster — the probe was disabled, never ran, or its
  // pods aged out. The controls stay usable because most such clusters do
  // enforce; the notice is what stops "no warning" from reading as "verified".
  const enforcementUnverified =
    enforcementStatus === "unknown" || enforcementStatus === null;
  return (
    <div className="space-y-4">
      {enforcementUnavailable ? (
        <Alert variant="warning">
          <TriangleAlert className="h-4 w-4" />
          <AlertTitle>Network policy enforcement test failed</AlertTitle>
          <AlertDescription className="block leading-6">
            Egress rules would be accepted and then ignored, so these controls
            stay disabled until the cluster enforces NetworkPolicy.{" "}
            <ExternalDocsLink
              href={NETWORK_POLICY_DOCS_URL}
              className="underline"
              showIcon={false}
            >
              View docs
            </ExternalDocsLink>
          </AlertDescription>
        </Alert>
      ) : enforcementUnverified ? (
        <Alert variant="info">
          <Info className="h-4 w-4" />
          <AlertTitle>Network policy enforcement not verified</AlertTitle>
          <AlertDescription className="block leading-6">
            Nothing has confirmed this cluster acts on NetworkPolicy, so the
            rules below may be accepted and then ignored. They are still
            applied, and the enforcement check runs on the next upgrade.{" "}
            <ExternalDocsLink
              href={NETWORK_POLICY_DOCS_URL}
              className="underline"
              showIcon={false}
            >
              View docs
            </ExternalDocsLink>
          </AlertDescription>
        </Alert>
      ) : !baselineLoaded ? (
        <Alert variant="info">
          <Info className="h-4 w-4" />
          <AlertTitle>Organization default not loaded</AlertTitle>
          <AlertDescription className="block leading-6">
            This environment inherits its egress from the organization default,
            which hasn't loaded. Editing is disabled until it's available, so a
            change isn't saved against the wrong baseline.
          </AlertDescription>
        </Alert>
      ) : !supportsFqdn ? (
        <Alert variant="info">
          <Info className="h-4 w-4" />
          <AlertTitle>Domain allowlists unavailable</AlertTitle>
          <AlertDescription className="block leading-6">
            Standard Kubernetes{" "}
            <code className="inline rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
              NetworkPolicy
            </code>{" "}
            supports IP/CIDR rules only. Domain allowlists require a supported
            FQDN policy provider.{" "}
            <ExternalDocsLink
              href={NETWORK_POLICY_DOCS_URL}
              className="underline"
              showIcon={false}
            >
              View docs
            </ExternalDocsLink>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-2">
        <div className="space-y-1">
          <Label htmlFor="network-policy-egress">Egress</Label>
          <FieldDescription>
            Choose whether workloads can reach nothing, only approved
            destinations, or the public internet. Public internet keeps private
            and reserved ranges blocked.{" "}
            <ExternalDocsLink
              href={PUBLIC_INTERNET_FLOOR_DOCS_URL}
              className="underline"
              showIcon={false}
            >
              View blocked ranges
            </ExternalDocsLink>
          </FieldDescription>
        </div>
        <Select
          value={egressMode}
          onValueChange={(value) => setEgressMode(value as EgressMode)}
          disabled={disabled || enforcementUnavailable}
        >
          <SelectTrigger id="network-policy-egress" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="off" description={EGRESS_MODE_DESCRIPTIONS.off}>
              {EGRESS_MODE_LABELS.off}
            </SelectItem>
            <SelectItem
              value="restricted"
              description={EGRESS_MODE_DESCRIPTIONS.restricted}
            >
              {EGRESS_MODE_LABELS.restricted}
            </SelectItem>
            <SelectItem
              value="unrestricted"
              description={EGRESS_MODE_DESCRIPTIONS.unrestricted}
            >
              {EGRESS_MODE_LABELS.unrestricted}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <FieldLabel
          htmlFor="network-policy-cidrs"
          label={
            egressMode === "unrestricted"
              ? "Additional allowed CIDRs"
              : "Allowed CIDRs"
          }
          description={
            egressMode === "unrestricted" ? (
              <>
                Optional IPv4 or IPv6 CIDR ranges to allow in addition to public
                internet. Other private and reserved ranges remain blocked.{" "}
                <ExternalDocsLink
                  href={PUBLIC_INTERNET_FLOOR_DOCS_URL}
                  className="underline"
                  showIcon={false}
                >
                  View blocked ranges
                </ExternalDocsLink>
              </>
            ) : egressMode === "off" ? (
              "CIDR exceptions are unavailable while all egress is blocked."
            ) : (
              "IPv4 or IPv6 CIDR ranges that workloads in Allowlist mode may reach."
            )
          }
        />
        <Textarea
          id="network-policy-cidrs"
          value={allowedCidrsText}
          onChange={(e) => setAllowedCidrsText(e.target.value)}
          placeholder={"10.20.0.0/16\nfd00:1234::/64"}
          className="min-h-20 font-mono text-sm"
          disabled={disabled || enforcementUnavailable || egressMode === "off"}
        />
      </div>

      <div className="space-y-2">
        <FieldLabel
          htmlFor="network-policy-domain-preset"
          label="Domain preset"
          description={
            <>
              Adds a maintained domain allowlist for common dependency or
              package manager traffic. Requires a supported FQDN policy
              provider.{" "}
              <ExternalDocsLink
                href={DOMAIN_PRESETS_DOCS_URL}
                className="underline"
                showIcon={false}
              >
                View presets
              </ExternalDocsLink>
            </>
          }
        />
        <Select
          value={domainPreset}
          onValueChange={(value) => setDomainPreset(value as DomainPreset)}
          disabled={disabled || egressMode !== "restricted" || !supportsFqdn}
        >
          <SelectTrigger id="network-policy-domain-preset" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">None</SelectItem>
            <SelectItem value="common_dependencies">
              Common dependencies
            </SelectItem>
            <SelectItem value="package_managers">Package managers</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <FieldLabel
          htmlFor="network-policy-domains"
          label="Allowed domains"
          description="Domain names or wildcard domains that workloads in Allowlist mode may reach. Requires a supported FQDN policy provider."
        />
        <Textarea
          id="network-policy-domains"
          value={allowedDomainsText}
          onChange={(e) => setAllowedDomainsText(e.target.value)}
          placeholder={"api.example.com\n*.registry.example.com"}
          className="min-h-20 font-mono text-sm"
          disabled={disabled || egressMode !== "restricted" || !supportsFqdn}
        />
      </div>
    </div>
  );
}

function FieldLabel({
  htmlFor,
  label,
  description,
}: {
  htmlFor?: string;
  label: string;
  description: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={htmlFor}>{label}</Label>
      <div className="text-xs text-muted-foreground">{description}</div>
    </div>
  );
}

export const EGRESS_MODE_LABELS: Record<EgressMode, string> = {
  off: "Block all",
  restricted: "Allowlist",
  unrestricted: "Public internet",
};

const EGRESS_MODE_DESCRIPTIONS: Record<EgressMode, string> = {
  off: "Block all outbound traffic.",
  restricted: "Allow only the CIDRs and domains configured below.",
  unrestricted:
    "Allow public destinations plus any additional CIDRs configured below.",
};

const NETWORK_POLICY_DOCS_URL = getDocsUrl(
  DocsPage.PlatformEnvironments,
  "network-egress-policies",
);
const PUBLIC_INTERNET_FLOOR_DOCS_URL = getDocsUrl(
  DocsPage.PlatformEnvironments,
  "the-public-internet-floor",
);
const DOMAIN_PRESETS_DOCS_URL = getDocsUrl(
  DocsPage.PlatformEnvironments,
  "domain-presets",
);
