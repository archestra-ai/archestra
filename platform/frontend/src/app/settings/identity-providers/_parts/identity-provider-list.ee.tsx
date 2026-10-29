// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import { E2eTestId } from "@archestra/shared";
import { IdentityProviderIcon } from "@/components/identity-provider-icons.ee";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface ProviderOverviewProps {
  providers: Array<{
    id: string;
    providerId: string;
    name: string;
    description: string;
    protocol: "oidc" | "saml";
    configured: boolean;
    signInEnabled: boolean;
  }>;
  onSelect: (id: string) => void;
}

export function IdentityProviderList({
  providers,
  onSelect,
}: ProviderOverviewProps) {
  return (
    <ul
      aria-label="Identity providers"
      className="divide-y overflow-hidden rounded-lg border"
    >
      {providers.map((provider) => (
        <li
          key={provider.id}
          data-testid={`${E2eTestId.IdentityProviderCard}-${provider.id}`}
          className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 px-4 py-3 sm:p-4 sm:grid-cols-[1.25rem_minmax(0,1fr)_8rem_6rem] sm:items-center"
        >
          <span aria-hidden="true" className="pt-0.5 sm:pt-0">
            <IdentityProviderIcon
              providerId={provider.providerId || provider.id}
              size={20}
            />
          </span>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-sm font-medium">{provider.name}</span>
              <span className="text-xs text-muted-foreground">
                {provider.protocol.toUpperCase()}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {provider.description}
            </p>
          </div>
          <div className="hidden sm:col-start-3 sm:row-start-1 sm:block">
            {provider.configured ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant="secondary"
                    tabIndex={0}
                    className="cursor-help focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span>Configured</span>
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  <span>
                    {provider.signInEnabled
                      ? "This provider is enabled for sign-in."
                      : "Linked for tools only. Sign-in is disabled."}
                  </span>
                </TooltipContent>
              </Tooltip>
            ) : (
              <Badge variant="outline">
                <span>Not configured</span>
              </Badge>
            )}
          </div>
          <Button
            data-testid={`${E2eTestId.IdentityProviderOpenDialogButton}-${provider.id}`}
            type="button"
            variant="outline"
            size="sm"
            className="col-start-3 row-start-1 justify-self-end sm:col-start-4"
            aria-label={`${provider.configured ? "Edit" : "Configure"} ${provider.name}`}
            onClick={() => onSelect(provider.id)}
          >
            <span>{provider.configured ? "Edit" : "Configure"}</span>
          </Button>
        </li>
      ))}
    </ul>
  );
}
