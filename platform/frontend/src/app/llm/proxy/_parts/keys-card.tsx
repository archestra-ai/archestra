"use client";

import { LLM_PROXY_OAUTH_SCOPE } from "@archestra/shared";
import Link from "next/link";
import { useState } from "react";
import { CreateVirtualKeyDialogWithData } from "@/components/create-virtual-key-dialog";
import { Button } from "@/components/ui/button";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useIdentityProviders } from "@/lib/auth/identity-provider-read.query";
import { useLimits } from "@/lib/limits.query";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { useOauthClients } from "@/lib/oauth-clients.query";
import { formatCurrency } from "@/lib/utils/format-currency";
import { useAllVirtualApiKeys } from "@/lib/virtual-api-keys.query";
import {
  ChipLink,
  ChipRow,
  DashboardCard,
  EmptyBox,
  FooterAction,
  FooterLink,
  MoreLink,
  NotSetUpBadge,
  ProviderStack,
} from "./dashboard-card";

const VISIBLE_KEYS = 3;
/** A key's spend limit counts as nearly used up from this share on. */
const NEAR_BUDGET = 0.8;
const STANDARD_KEYS_HREF = "/llm/proxy/virtual-keys?keyType=standard";

/**
 * The standard virtual keys apps call the proxy with; a dot marks one that has
 * used most of its spend limit. Below them, the other ways apps can sign in,
 * each with how many exist.
 */
export function KeysCard() {
  const { data: keys, isPending } = useAllVirtualApiKeys({
    keyType: "standard",
    limit: VISIBLE_KEYS,
    offset: 0,
    toastOnError: false,
  });
  const { data: passthrough } = useAllVirtualApiKeys({
    keyType: "passthrough",
    limit: 1,
    offset: 0,
    toastOnError: false,
  });
  const { data: oauthClients } = useOauthClients({
    limit: 1,
    capability: LLM_PROXY_OAUTH_SCOPE,
    toastOnError: false,
  });
  const { data: canReadIdentityProviders } = useHasPermissions({
    identityProvider: ["read"],
  });
  const { data: identityProviders = [] } = useIdentityProviders({
    enabled: canReadIdentityProviders === true,
  });
  const { data: providerKeys = [] } = useLlmProviderApiKeys();
  const { data: canReadLimits } = useHasPermissions({ llmLimit: ["read"] });
  const { data: spendLimits = [] } = useLimits({
    enabled: canReadLimits === true,
    filters: { entityType: "virtual_key", limitType: "token_cost" },
  });
  const { data: canCreate } = useHasPermissions({ llmVirtualKey: ["create"] });
  const [creating, setCreating] = useState(false);

  const total = keys?.pagination.total ?? 0;
  const isEmpty = !isPending && total === 0;
  const hasProviderKey = providerKeys.length > 0;
  const spendOf = (keyId: string) => {
    const limit = spendLimits.find((entry) => entry.entityId === keyId);
    if (!limit || limit.limitValue <= 0) return null;
    const used = (limit.modelUsage ?? []).reduce(
      (sum, usage) => sum + usage.cost,
      0,
    );
    return { used, limit: limit.limitValue };
  };

  const otherWays = [
    {
      label: "Passthrough",
      count: passthrough?.pagination.total ?? 0,
      href: "/llm/proxy/virtual-keys?keyType=passthrough",
      tip: "Callers use their own provider key; the key only attributes requests",
    },
    {
      label: "OAuth clients",
      count: oauthClients?.pagination.total ?? 0,
      href: "/settings/oauth-clients?type=llm",
      tip: "Apps get a token, as themselves or for a signed-in user",
    },
    // Only those who can read identity providers can count or open them.
    ...(canReadIdentityProviders
      ? [
          {
            label: "Identity providers",
            count: identityProviders.length,
            href: "/settings/identity-providers",
            tip: "Apps forward the user's JWT from your identity provider",
          },
        ]
      : []),
  ];

  return (
    <DashboardCard
      id="llm-proxy-keys"
      title="Virtual keys"
      count={total}
      note="Attribute costs per app or user, hide real provider keys"
      status={isEmpty && <NotSetUpBadge>Not set up</NotSetUpBadge>}
      footer={
        <>
          {canCreate && (
            <FooterAction onClick={() => setCreating(true)}>
              + Create key
            </FooterAction>
          )}
          <FooterLink href={STANDARD_KEYS_HREF} className="ml-auto">
            Manage
          </FooterLink>
        </>
      }
    >
      {isEmpty ? (
        <EmptyBox>
          <span className="text-[13.5px] font-medium">
            Create a virtual key for an app or user
          </span>
          <span className="text-[12.5px] text-muted-foreground">
            Revoke any time.
          </span>
          {canCreate && (
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              // A key maps provider keys, so there must be one first.
              disabled={!hasProviderKey}
              onClick={() => setCreating(true)}
            >
              + Create key
            </Button>
          )}
        </EmptyBox>
      ) : (
        <ChipRow>
          {(keys?.data ?? []).map((key) => {
            const spend = spendOf(key.id);
            const nearBudget =
              !!spend && spend.used >= spend.limit * NEAR_BUDGET;
            return (
              <ChipLink
                key={key.id}
                href={`${STANDARD_KEYS_HREF}&search=${encodeURIComponent(key.name)}&edit=${key.id}`}
                title={
                  spend
                    ? `${formatCurrency(spend.used)} of ${formatCurrency(spend.limit)} used`
                    : undefined
                }
              >
                <span className="truncate font-medium">{key.name}</span>
                <ProviderStack
                  providers={key.providerApiKeys.map(
                    (mapping) => mapping.provider,
                  )}
                />
                {nearBudget && (
                  <span
                    role="img"
                    aria-label="Near budget"
                    className="size-1.5 shrink-0 rounded-full bg-amber-500"
                  />
                )}
              </ChipLink>
            );
          })}
          <MoreLink href={STANDARD_KEYS_HREF} count={total - VISIBLE_KEYS} />
        </ChipRow>
      )}

      <div className="flex flex-col gap-1.5 rounded-[10px] bg-muted/40 px-3 py-2.5">
        <span className="text-[11.5px] text-muted-foreground">
          Other ways apps can sign in
        </span>
        <div className="flex flex-wrap gap-1.5">
          {otherWays.map((way) => (
            <Link
              key={way.label}
              href={way.href}
              title={way.tip}
              className="inline-flex h-[26px] items-center gap-1.5 rounded-[7px] border bg-card px-2.5 text-[12.5px] text-foreground hover:bg-accent"
            >
              {way.label}
              <span className="text-muted-foreground tabular-nums">
                {way.count}
              </span>
            </Link>
          ))}
        </div>
      </div>

      <CreateVirtualKeyDialogWithData
        open={creating}
        onOpenChange={setCreating}
        keyType="standard"
      />
    </DashboardCard>
  );
}
