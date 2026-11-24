"use client";

import type { SupportedProvider } from "@archestra/shared";
import { ChevronDown, Layers, Shuffle } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { ConfigureAutoRoutingDialog } from "@/app/llm/auto-routing/_parts/configure-dialog";
import { PoolDialog } from "@/app/llm/model-pools/_parts/pool-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { type AutoRouter, useAutoRouters } from "@/lib/auto-routing.query";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import { type ModelPool, useModelPools } from "@/lib/model-pools.query";
import {
  ChipLink,
  ChipRow,
  DashboardCard,
  EmptyBox,
  FooterAction,
  MoreLink,
  NotSetUpBadge,
  ProviderStack,
} from "./dashboard-card";

const VISIBLE_NAMES = 4;
const TIERS = ["fast", "normal", "smart"] as const;

/**
 * The names apps can ask for besides a model: auto routers, which pick a model
 * per request, and pools, which fail over between provider keys. Each opens
 * its own page; the footer creates either one here.
 */
export function PoolsCard() {
  const providerCatalog = useModelProviderCatalog({ fresh: true });
  const { data: pools = [], isPending: poolsPending } = useModelPools({
    toastOnError: false,
  });
  const { data: routers = [], isPending: routersPending } = useAutoRouters();
  const { data: canCreatePool } = useHasPermissions({ llmModel: ["update"] });
  const { data: canCreateRouter } = useHasPermissions({
    llmProxy: ["update"],
  });
  const [creating, setCreating] = useState<"pool" | "router" | null>(null);

  const total = pools.length + routers.length;
  const isEmpty = !poolsPending && !routersPending && total === 0;
  const routerProviders = (router: AutoRouter) =>
    TIERS.flatMap((tier) => router.tiers[tier]?.provider ?? []);
  const routerTip = (router: AutoRouter) =>
    TIERS.map(
      (tier) =>
        `${tier[0].toUpperCase()}${tier.slice(1)}: ${router.tiers[tier]?.modelId ?? "none"}`,
    ).join(" · ");
  // Members in the order requests try them.
  const poolProviders = (pool: ModelPool) =>
    [...pool.members]
      .filter((member) => member.enabled)
      .sort((a, b) => a.priority - b.priority)
      .map((member) => member.provider as SupportedProvider);
  const poolTip = (pool: ModelPool) =>
    [...new Set(poolProviders(pool))]
      .map((provider) => providerCatalog.label(provider))
      .join(" → ");

  const items = [
    ...routers.map((router) => ({
      key: router.id,
      kind: router.enabled ? "Router" : "Router · off",
      name: router.name,
      href: `/llm/auto-routing/${router.id}`,
      tip: routerTip(router),
      providers: routerProviders(router),
    })),
    ...pools.map((pool) => ({
      key: pool.id,
      kind: "Pool",
      name: pool.name,
      href: `/llm/model-pools?search=${encodeURIComponent(pool.name)}&edit=${pool.id}`,
      tip: poolTip(pool),
      providers: poolProviders(pool),
    })),
  ];

  return (
    <DashboardCard
      id="llm-proxy-pools"
      title="Pools and routers"
      count={total}
      note="Load balancing and failover across keys"
      status={isEmpty && <NotSetUpBadge>Optional</NotSetUpBadge>}
      footer={
        <>
          {canCreatePool && (
            <FooterAction onClick={() => setCreating("pool")}>
              + Pool
            </FooterAction>
          )}
          {canCreateRouter && (
            <FooterAction onClick={() => setCreating("router")}>
              + Router
            </FooterAction>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <UnstyledButton
                type="button"
                className="ml-auto inline-flex items-center gap-1 text-muted-foreground hover:underline"
              >
                Manage
                <ChevronDown className="size-3.5" aria-hidden />
              </UnstyledButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link href="/llm/model-pools">
                  <Layers />
                  Model Pools
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href="/llm/auto-routing">
                  <Shuffle />
                  Auto Routing
                </Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
    >
      {isEmpty ? (
        <EmptyBox>
          <span className="text-[12.5px] text-muted-foreground">
            If one provider fails or hits a rate limit, requests move to the
            next.
          </span>
        </EmptyBox>
      ) : (
        <ChipRow>
          {items.slice(0, VISIBLE_NAMES).map((item) => (
            <ChipLink key={item.key} href={item.href} title={item.tip}>
              <span className="text-[11.5px] text-muted-foreground">
                {item.kind}
              </span>
              <code className="truncate font-mono text-[12.5px] font-medium">
                {item.name}
              </code>
              <ProviderStack providers={item.providers} />
            </ChipLink>
          ))}
          <MoreLink
            href={
              pools.length >= routers.length
                ? "/llm/model-pools"
                : "/llm/auto-routing"
            }
            count={items.length - VISIBLE_NAMES}
          />
        </ChipRow>
      )}

      {creating === "pool" && (
        <PoolDialog
          pool={null}
          onOpenChange={(open) => {
            if (!open) setCreating(null);
          }}
          onCreated={() => setCreating(null)}
        />
      )}
      {creating === "router" && (
        <ConfigureAutoRoutingDialog
          router={null}
          existingNames={routers.map((router) => router.name)}
          onOpenChange={(open) => {
            if (!open) setCreating(null);
          }}
        />
      )}
    </DashboardCard>
  );
}
