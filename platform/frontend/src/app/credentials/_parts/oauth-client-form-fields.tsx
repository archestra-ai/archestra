"use client";

import {
  AgentSelector,
  type AgentSelectorAgent,
} from "@/components/agent-selector";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

// Form fields shared between the unified create dialog and the per-type edit
// dialogs (the grant type and access target are fixed at creation, so the edit
// dialogs only reuse the field components, not the pickers for those).

export function parseRedirectUris(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function RedirectUrisField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor="oauth-client-redirect-uris">Redirect URIs</Label>
      <Textarea
        id="oauth-client-redirect-uris"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={"https://your-app.example.com/oauth/callback"}
        rows={3}
      />
      <p className="text-sm text-muted-foreground">
        The registering application's own callback URL(s) — where users are sent
        after they authorize, not an address on this server. Must match the
        <code className="mx-1">redirect_uri</code>the app sends. One per line.
      </p>
    </div>
  );
}

export function GatewayGrantField({
  gateways,
  value,
  onValueChange,
}: {
  gateways: AgentSelectorAgent[];
  value: string[];
  onValueChange: (value: string[]) => void;
}) {
  return (
    <div className="space-y-2">
      <Label>Gateway access grant (optional)</Label>
      <AgentSelector
        mode="multiple"
        flat
        agents={gateways}
        value={value}
        onValueChange={onValueChange}
        placeholder="Select gateways to grant"
        searchPlaceholder="Search gateways"
        emptyMessage="No gateways found"
      />
      <p className="text-sm text-muted-foreground">
        Grants any user who authenticates through this client access to the
        selected gateways — <strong>in addition to</strong> their own role-based
        access, even gateways they otherwise couldn't reach. Leave empty for
        pure identity passthrough (access stays governed by each user's
        permissions).
      </p>
    </div>
  );
}

export function ProxyGrantField({
  llmProxies,
  value,
  onValueChange,
}: {
  llmProxies: AgentSelectorAgent[];
  value: string[];
  onValueChange: (value: string[]) => void;
}) {
  return (
    <div className="space-y-2">
      <Label>LLM proxy access grant (optional)</Label>
      <AgentSelector
        mode="multiple"
        flat
        agents={llmProxies}
        value={value}
        onValueChange={onValueChange}
        placeholder="Select LLM proxies to grant"
        searchPlaceholder="Search LLM proxies"
        emptyMessage="No LLM proxies found"
      />
      <p className="text-sm text-muted-foreground">
        Grants any user who authenticates through this client access to the
        selected LLM proxies — <strong>in addition to</strong> their own
        role-based access, even proxies they otherwise couldn't reach. Leave
        empty for pure identity passthrough (access stays governed by each
        user's permissions). Each user's own provider keys are still used.
      </p>
    </div>
  );
}
