"use client";

import { MoreHorizontal } from "lucide-react";
import type { LlmProviderApiKeyResponse } from "@/components/llm-provider-api-key-form";
import { SubscriptionBrandIcon } from "@/components/subscription-brand-icon";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PermissionButton } from "@/components/ui/permission-button";
import { Skeleton } from "@/components/ui/skeleton";
import { useLlmModels } from "@/lib/llm-models.query";
import { useResourcePermissions } from "@/lib/resource-permissions.query";

/**
 * Subscriptions an organization pays for, which members use without a seat of
 * their own: today, GitHub Copilot through a GitHub App on the organization.
 * They sit between the personal subscriptions and the provider API keys.
 */
export function OrganizationSubscriptionCards({
  credentials,
  isLoading,
  onConnect,
  onManageAccess,
  onReplace,
  onDisconnect,
}: {
  /** The organization's GitHub Copilot keys (GitHub App credentials). */
  credentials: LlmProviderApiKeyResponse[];
  isLoading: boolean;
  onConnect: () => void;
  onManageAccess: (credential: LlmProviderApiKeyResponse) => void;
  onReplace: (credential: LlmProviderApiKeyResponse) => void;
  onDisconnect: (credential: LlmProviderApiKeyResponse) => void;
}) {
  return (
    <section
      className="space-y-3"
      aria-labelledby="organization-subscriptions-heading"
    >
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="space-y-1">
          <h2
            id="organization-subscriptions-heading"
            className="text-sm font-medium"
          >
            Organization subscriptions
          </h2>
          <p className="text-sm text-muted-foreground">
            Connect a subscription your organization pays for. Members use it
            without their own seat.
          </p>
        </div>
        {credentials.length > 0 && (
          <PermissionButton
            permissions={{ llmProviderApiKey: ["create"] }}
            variant="outline"
            size="sm"
            onClick={onConnect}
          >
            <span>Connect another organization</span>
          </PermissionButton>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {isLoading ? (
          <Card className="gap-3 px-4 py-4">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-4 w-48" />
          </Card>
        ) : credentials.length === 0 ? (
          <Card className="gap-3 px-4 py-4">
            <CardTitle />
            <p className="text-sm text-muted-foreground">
              Use your GitHub organization's Copilot plan
            </p>
            <div className="mt-auto flex items-center justify-between gap-2 pt-1">
              <span className="text-sm text-muted-foreground">
                Not connected
              </span>
              <PermissionButton
                permissions={{ llmProviderApiKey: ["create"] }}
                variant="outline"
                size="sm"
                onClick={onConnect}
              >
                <span>Connect</span>
              </PermissionButton>
            </div>
          </Card>
        ) : (
          credentials.map((credential) => (
            <ConnectedCard
              key={credential.id}
              credential={credential}
              onManageAccess={onManageAccess}
              onReplace={onReplace}
              onDisconnect={onDisconnect}
            />
          ))
        )}
      </div>
    </section>
  );
}

/** "Everyone in the organization", the names granted use, or "Admins only". */
export function describeKeyAudience(
  grants: Array<{
    subject: { type: string };
    actions: string[];
    name: string;
  }>,
): string {
  const users = grants.filter((grant) => grant.actions.includes("use"));
  if (users.some((grant) => grant.subject.type === "organization"))
    return "Everyone in the organization";
  if (users.length === 0) return "Admins only";
  const names = users.map((grant) => grant.name);
  return names.length > 2
    ? `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`
    : names.join(", ");
}

function CardTitle() {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <SubscriptionBrandIcon
        kind="github-copilot"
        provider="github-copilot"
        size={20}
      />
      <span className="min-w-0 truncate font-medium">GitHub Copilot</span>
    </div>
  );
}

function ConnectedCard({
  credential,
  onManageAccess,
  onReplace,
  onDisconnect,
}: {
  credential: LlmProviderApiKeyResponse;
  onManageAccess: (credential: LlmProviderApiKeyResponse) => void;
  onReplace: (credential: LlmProviderApiKeyResponse) => void;
  onDisconnect: (credential: LlmProviderApiKeyResponse) => void;
}) {
  const organization = credential.githubOrganization ?? "Your organization";
  const { data: models } = useLlmModels({ apiKeyId: credential.id });
  const { data: permissions } = useResourcePermissions(
    "llmProviderApiKey",
    credential.id,
  );
  const modelCount =
    models === undefined
      ? null
      : `${models.length} ${models.length === 1 ? "model" : "models"}`;
  const audience = permissions ? describeKeyAudience(permissions.grants) : null;

  return (
    <Card className="gap-3 px-4 py-4">
      <CardTitle />
      <div className="space-y-0.5 text-sm text-muted-foreground">
        <p className="truncate" title={organization}>
          {`${organization} · billed to ${organization} on GitHub`}
        </p>
        <p>{[modelCount, audience].filter(Boolean).join(" · ")}</p>
      </div>
      <div className="mt-auto flex items-center justify-end gap-1 pt-1">
        <PermissionButton
          permissions={{ llmProviderApiKey: ["update"] }}
          permissionScope={credential.id}
          variant="outline"
          size="sm"
          onClick={() => onManageAccess(credential)}
        >
          <span>Manage access</span>
        </PermissionButton>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <PermissionButton
              permissions={{}}
              variant="ghost"
              size="icon-sm"
              aria-label={`More actions for ${organization}`}
            >
              <MoreHorizontal className="h-4 w-4" />
            </PermissionButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onReplace(credential)}>
              Replace App credentials
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={() => onDisconnect(credential)}
            >
              Disconnect
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </Card>
  );
}
