"use client";

import { usePathname } from "next/navigation";
import { type ReactNode, useState } from "react";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { PageLayout } from "@/components/page-layout";
import { Badge } from "@/components/ui/badge";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { BatteriesUploadAction } from "./batteries-panel";
import { OpenAppaPageActionSlotContext } from "./openappa-page-action";
import { openAppaUrl } from "./overview-setup-cards";
import { useOpenAppaSetupState } from "./use-openappa-setup-state";

export function OpenAppaPageLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [pageActionSlot, setPageActionSlot] = useState<HTMLDivElement | null>(
    null,
  );
  const { data: canReadYells } = useHasPermissions({
    openappaDiagnostics: ["read"],
  });
  const { data: canReadPolicy } = useHasPermissions({
    openappaPolicy: ["read"],
  });
  const appName = useAppName();
  const { isFresh } = useOpenAppaSetupState();
  const page =
    pathname === "/openappa/batteries"
      ? {
          title: "Batteries",
          description:
            "Add and manage reusable policy rules for your tools. See which batteries are active and what they need to work.",
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

  return (
    <PageLayout
      // Maturity, not runtime state, so it belongs to the name rather than to
      // the `status` pill beside it. Laid out inline with a real space rather
      // than a flex gap: a CSS gap leaves no separator in the accessible name,
      // which a screen reader then reads as one word.
      title={
        <span>
          {page.title}{" "}
          <Badge variant="secondary" className="align-middle">
            Alpha
          </Badge>
        </span>
      }
      documentTitle={page.title}
      description={page.description}
      tabs={
        firstStepOnly
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
        pathname === "/openappa/validation" ? (
          <div ref={setPageActionSlot} />
        ) : firstStepOnly ||
          pathname === "/openappa/yells" ||
          pathname === "/openappa/tests" ||
          pathname.startsWith("/openappa/validation") ||
          pathname === "/openappa/policy" ? null : (
          <BatteriesUploadAction />
        )
      }
    >
      <OpenAppaPageActionSlotContext.Provider value={pageActionSlot}>
        {children}
      </OpenAppaPageActionSlotContext.Provider>
    </PageLayout>
  );
}
