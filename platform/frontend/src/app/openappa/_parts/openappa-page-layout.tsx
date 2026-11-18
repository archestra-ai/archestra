"use client";

import { DocsPage, getDocsUrl } from "@archestra/shared";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { PageLayout } from "@/components/page-layout";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useServerRulesAccess } from "@/lib/openappa-github-sync.query";
import { GUARDRAILS_BETA_TOOLTIP } from "@/lib/openappa-maturity";
import { OverviewHeaderActions } from "./overview-header-actions";
import { openAppaUrl } from "./overview-setup-cards";
import { useOpenAppaSetupState } from "./use-openappa-setup-state";

export function OpenAppaPageLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { data: canReadPolicy } = useHasPermissions({
    guardrailsPolicy: ["read"],
  });
  // A reader of MCP servers' rules alone: the Policy page, for those files.
  const scoped = useServerRulesAccess().scoped === true;
  const appName = useAppName();
  const { isFresh } = useOpenAppaSetupState();
  const page =
    pathname === "/openappa/batteries"
      ? {
          title: "Batteries",
          description: (
            <>
              <span>
                Batteries are ready-made sets of guardrail rules for your tools
                and services. See which are active and what they need to work.
              </span>{" "}
              <ExternalDocsLink
                href={getDocsUrl(
                  DocsPage.PlatformAiToolGuardrailsPolicies,
                  "batteries",
                )}
              >
                Learn more
              </ExternalDocsLink>
            </>
          ),
        }
      : pathname === "/openappa/policy"
        ? {
            title: "Policy",
            description: scoped
              ? "The guardrail rules for your MCP servers. Open a file to see what its tools may do."
              : "The files that decide what an agent's tool calls may do: your organization's policy, the batteries it includes, and the validations that check them.",
          }
        : {
            title: "Guardrails",
            description: (
              <>
                {`${appName} uses OpenAPPA to check tool calls against your policy and keep data visible only to people allowed to see it.`}{" "}
                <ExternalDocsLink href={openAppaUrl("/how-it-works")}>
                  How it works
                </ExternalDocsLink>
              </>
            ),
          };
  // Until a policy is saved, the Overview shows only that first step.
  const firstStepOnly = isFresh === true && pathname === "/openappa";

  return (
    <PageLayout
      // Maturity, not runtime state, so it belongs to the name rather than to
      // the `status` pill beside it. Laid out inline with a real space rather
      // than a flex gap: a CSS gap leaves no separator in the accessible name,
      // which a screen reader then reads as one word.
      title={
        <span>
          {page.title}{" "}
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="secondary" className="align-middle">
                Beta
              </Badge>
            </TooltipTrigger>
            <TooltipContent>{GUARDRAILS_BETA_TOOLTIP}</TooltipContent>
          </Tooltip>
        </span>
      }
      // The policy source is an editor: it takes the height the viewport has.
      fillContent={pathname === "/openappa/policy"}
      documentTitle={page.title}
      description={page.description}
      tabs={
        firstStepOnly
          ? []
          : [
              ...(canReadPolicy
                ? [
                    { label: "Overview", href: "/openappa" },
                    { label: "Policy", href: "/openappa/policy" },
                    { label: "Batteries", href: "/openappa/batteries" },
                  ]
                : scoped
                  ? [{ label: "Policy", href: "/openappa/policy" }]
                  : []),
            ]
      }
      actionButton={
        !firstStepOnly && pathname === "/openappa" ? (
          <OverviewHeaderActions />
        ) : null
      }
    >
      {children}
    </PageLayout>
  );
}
