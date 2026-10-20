"use client";

import { DocsPage, getDocsUrl } from "@archestra/shared";
import { usePathname } from "next/navigation";
import { type ReactNode, useState } from "react";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { PageBackLink } from "@/components/page-back-link";
import { PageLayout } from "@/components/page-layout";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { GUARDRAILS_BETA_TOOLTIP } from "@/lib/openappa-maturity";
import {
  OpenAppaHeaderModeContext,
  OpenAppaPageActionSlotContext,
  OpenAppaPageHeaderSlotsContext,
} from "./openappa-page-action";
import { OverviewHeaderActions } from "./overview-header-actions";
import { openAppaUrl } from "./overview-setup-cards";
import { useOpenAppaSetupState } from "./use-openappa-setup-state";

export function OpenAppaPageLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [pageActionSlot, setPageActionSlot] = useState<HTMLDivElement | null>(
    null,
  );
  const [titleSlot, setTitleSlot] = useState<HTMLSpanElement | null>(null);
  const [statusSlot, setStatusSlot] = useState<HTMLSpanElement | null>(null);
  const [descriptionSlot, setDescriptionSlot] =
    useState<HTMLSpanElement | null>(null);
  const [requestedMode, setRequestedMode] = useState<{
    back: boolean;
  } | null>(null);
  // A validation file is a detail page: it names itself in the header and
  // leads back to the list, instead of repeating "Validations" and the tabs.
  // Other pages can ask for the same header with `useOpenAppaDetailHeader`.
  const fileDetail = pathname === "/openappa/validation/file";
  const detail = fileDetail || requestedMode !== null;
  const { data: canReadYells } = useHasPermissions({
    log: ["read"],
  });
  const { data: canReadPolicy } = useHasPermissions({
    guardrailsPolicy: ["read"],
  });
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
                href={getDocsUrl(DocsPage.PlatformAiToolGuardrailsBatteries)}
              >
                Learn more
              </ExternalDocsLink>
            </>
          ),
        }
      : pathname === "/openappa/policy"
        ? {
            title: "Policy",
            description:
              "Review your guardrail policy and the effective rules applied to tool calls, including rules from batteries.",
          }
        : pathname === "/openappa/tests" ||
            pathname.startsWith("/openappa/validation")
          ? {
              title:
                pathname === "/openappa/validation/history"
                  ? "Validation run history"
                  : pathname === "/openappa/validation/new"
                    ? "Add validation"
                    : "Validations",
              description:
                pathname === "/openappa/validation/history"
                  ? "Review previous validation results."
                  : pathname === "/openappa/validation/new"
                    ? "Write a scenario and save it as a validation file."
                    : "Write policy scenarios and check their expected decisions.",
            }
          : pathname.startsWith("/openappa/yells/")
            ? { title: "Yell", description: undefined }
            : pathname === "/openappa/yells"
              ? {
                  title: "Yells",
                  description:
                    "Yells are agent reports of blocks it could not make sense of or get past. Investigate them in chat and mark them resolved once fixed.",
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

  // One tree for both header forms, so switching never remounts the page.
  return (
    <PageLayout
      // Maturity, not runtime state, so it belongs to the name rather than to
      // the `status` pill beside it. Laid out inline with a real space rather
      // than a flex gap: a CSS gap leaves no separator in the accessible name,
      // which a screen reader then reads as one word.
      title={
        detail ? (
          <span ref={setTitleSlot} />
        ) : (
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
        )
      }
      documentTitle={fileDetail ? "Validation" : page.title}
      // The title carries the Beta badge, so on a phone it needs the full
      // row: beside the actions it broke mid-word and pushed the badge down.
      stackHeaderOnMobile
      // Two tabs plus the overflow menu fit a 320px phone without scrolling.
      mobileVisibleCount={2}
      backLink={
        fileDetail || requestedMode?.back ? (
          <PageBackLink href="/openappa/validation">
            Back to validations
          </PageBackLink>
        ) : undefined
      }
      status={
        detail ? (
          <span ref={setStatusSlot} className="empty:hidden" />
        ) : undefined
      }
      description={
        detail ? <span ref={setDescriptionSlot} /> : page.description
      }
      tabs={
        firstStepOnly || detail
          ? []
          : [
              ...(canReadPolicy
                ? [
                    { label: "Overview", href: "/openappa" },
                    { label: "Batteries", href: "/openappa/batteries" },
                    { label: "Policy", href: "/openappa/policy" },
                    { label: "Validations", href: "/openappa/validation" },
                  ]
                : []),
              ...(canReadYells
                ? [{ label: "Yells", href: "/openappa/yells" }]
                : []),
            ]
      }
      actionButton={
        pathname === "/openappa/validation" || fileDetail ? (
          <div ref={setPageActionSlot} />
        ) : firstStepOnly ||
          pathname.startsWith("/openappa/yells") ||
          pathname === "/openappa/tests" ||
          pathname.startsWith("/openappa/validation") ||
          pathname === "/openappa/policy" ? null : pathname === "/openappa" ? (
          <OverviewHeaderActions />
        ) : null
      }
    >
      <OpenAppaPageHeaderSlotsContext.Provider
        value={{
          title: titleSlot,
          status: statusSlot,
          description: descriptionSlot,
        }}
      >
        <OpenAppaPageActionSlotContext.Provider value={pageActionSlot}>
          <OpenAppaHeaderModeContext.Provider value={setRequestedMode}>
            {children}
          </OpenAppaHeaderModeContext.Provider>
        </OpenAppaPageActionSlotContext.Provider>
      </OpenAppaPageHeaderSlotsContext.Provider>
    </PageLayout>
  );
}
