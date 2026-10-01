"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { PageLayout } from "@/components/page-layout";
import { Badge } from "@/components/ui/badge";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { BatteriesUploadAction } from "./batteries-panel";
import { openAppaUrl } from "./overview-setup-cards";
import { useOpenAppaSetupState } from "./use-openappa-setup-state";

export function OpenAppaPageLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { data: canReadYells } = useHasPermissions({ log: ["read"] });
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
        : pathname === "/openappa/yells"
          ? {
              title: "Yells",
              description:
                "Yells are agent reports of confusing blocks or remedies. Investigate them in chat and mark them resolved once fixed.",
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
              { label: "Overview", href: "/openappa" },
              { label: "Batteries", href: "/openappa/batteries" },
              { label: "Policy", href: "/openappa/policy" },
              ...(canReadYells
                ? [{ label: "Yells", href: "/openappa/yells" }]
                : []),
            ]
      }
      actionButton={
        firstStepOnly ||
        pathname === "/openappa/yells" ||
        pathname === "/openappa/policy" ? null : (
          <BatteriesUploadAction />
        )
      }
    >
      {children}
    </PageLayout>
  );
}
