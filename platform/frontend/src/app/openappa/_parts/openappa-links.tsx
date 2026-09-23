import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Where the OpenAPPA specification explains each term the page uses. One map
 * so every tab links to the same place for the same idea.
 */
const OPENAPPA_DOCS =
  "https://github.com/archestra-ai/OpenAPPA/blob/main/website/content/docs";

export const OPENAPPA_SPEC = {
  contracts: `${OPENAPPA_DOCS}/contracts.md`,
  howItWorks: `${OPENAPPA_DOCS}/how-it-works.md`,
  batteries: `${OPENAPPA_DOCS}/batteries.md`,
  availableBatteries: `${OPENAPPA_DOCS}/available-batteries.md`,
  /** The page of one bundled battery. */
  battery: (name: string) => `${OPENAPPA_DOCS}/battery-${name}.md`,
  /** Anchors in `contracts.md`. */
  trust: `${OPENAPPA_DOCS}/contracts.md#trust`,
  audiences: `${OPENAPPA_DOCS}/contracts.md#audiences`,
  toolContracts: `${OPENAPPA_DOCS}/contracts.md#tool-contracts`,
  requirements: `${OPENAPPA_DOCS}/contracts.md#restrictions-and-requirements`,
  attention: `${OPENAPPA_DOCS}/contracts.md#attention`,
  authorities: `${OPENAPPA_DOCS}/contracts.md#authorities`,
  annotators: `${OPENAPPA_DOCS}/contracts.md#annotators`,
  sanitizers: `${OPENAPPA_DOCS}/contracts.md#sanitizers`,
  undeclaredTools: `${OPENAPPA_DOCS}/contracts.md#handling-undeclared-tools`,
  patternMatching: `${OPENAPPA_DOCS}/contracts.md#pattern-matching`,
  remedyPlans: `${OPENAPPA_DOCS}/contracts.md#remedy-plans-and-child-returns`,
  deploymentCoverage: `${OPENAPPA_DOCS}/contracts.md#deployment-coverage`,
  /** Anchors in `batteries.md`. */
  batteryStructure: `${OPENAPPA_DOCS}/batteries.md#battery-structure`,
  policyOrder: `${OPENAPPA_DOCS}/batteries.md#policy-order-when-batteries-are-used`,
  audienceSources: `${OPENAPPA_DOCS}/batteries.md#audience-sources`,
} as const;

/** A link out to the specification or the platform docs, marked as leaving the page. */
export function SpecLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap text-sm underline underline-offset-4",
        className,
      )}
    >
      <span>{children}</span>
      <ExternalLink aria-hidden className="size-3.5 shrink-0" />
    </a>
  );
}
