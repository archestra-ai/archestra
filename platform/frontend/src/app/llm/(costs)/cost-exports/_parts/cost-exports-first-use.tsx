"use client";

import { DocsPage, getDocsUrl } from "@archestra/shared";
import { FileSpreadsheet } from "lucide-react";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAppName } from "@/lib/hooks/use-app-name";
import type { ConfigureStep } from "./configure-step";
import { exampleObjectKey } from "./use-cost-export-form";

/**
 * The page before its first cost export: what an export is for, one Configure
 * button, and a sample of the file it writes. A reader who cannot set one up
 * gets a line saying who can, in place of the button.
 */
export function CostExportsFirstUse({
  step,
  onConfigure,
}: {
  step: ConfigureStep;
  onConfigure: () => void;
}) {
  const appName = useAppName();
  const canConfigure = step === "add-provider" || step === "schedule";

  return (
    <div className="flex flex-wrap items-center gap-x-12 gap-y-8 rounded-lg border px-6 py-10 sm:px-8">
      <div className="flex min-w-0 flex-[1_1_20rem] flex-col items-start">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl border bg-background shadow-sm">
          <FileSpreadsheet aria-hidden className="h-6 w-6 text-primary" />
        </div>
        {/* Not a heading, as in EmptyState: it would sit beside the page title. */}
        <p className="mt-5 text-2xl font-semibold tracking-tight text-balance">
          Track LLM spend together with your cloud bills
        </p>
        <p className="mt-3 max-w-md leading-relaxed text-pretty text-muted-foreground">
          {appName} exports LLM cost and usage data in FOCUS, the open format
          for billing data. AWS, Azure and Google Cloud export their bills in it
          too, so you can track LLM spend together with the rest of your costs.
        </p>
        {canConfigure && (
          <div className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-3">
            <Button size="sm" onClick={onConfigure}>
              Configure
            </Button>
            <ExternalDocsLink
              href={getDocsUrl(
                DocsPage.PlatformCostExports,
                "schedule-exports-to-object-storage",
              )}
              className="text-sm font-medium hover:underline"
            >
              Learn more
            </ExternalDocsLink>
          </div>
        )}
        {step === "cannot-schedule" && (
          <p className="mt-7 text-sm text-muted-foreground">
            Your admins haven't set up an export yet.
          </p>
        )}
        {step === "needs-provider" && (
          <p className="mt-7 text-sm text-muted-foreground">
            An admin needs to add a blob provider first.
          </p>
        )}
      </div>

      <figure
        aria-label="Example of an exported file"
        className="min-w-0 flex-[1.5_1_28rem] overflow-hidden rounded-lg border bg-background"
      >
        <figcaption className="border-b bg-muted px-4 py-3 font-mono text-xs break-all">
          {exampleObjectKey(SAMPLE_EXPORT)}
        </figcaption>
        <Table>
          <TableHeader>
            <TableRow>
              {SAMPLE_COLUMNS.map((column) => (
                <TableHead
                  key={column.focus}
                  className={column.numeric ? "text-right" : undefined}
                >
                  <span className="block font-mono text-xs text-foreground">
                    {column.focus}
                  </span>
                  <span className="block text-xs font-normal text-muted-foreground">
                    {column.meaning}
                  </span>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {SAMPLE_ROWS.map((row) => (
              <TableRow key={`${row.team}-${row.agent}`}>
                <TableCell>{row.team}</TableCell>
                <TableCell>{row.agent}</TableCell>
                <TableCell className="font-mono text-xs">{row.model}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.billedCost}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </figure>
    </div>
  );
}

// === internal ===

/** A daily export in the default folder, for the sample file's path. */
const SAMPLE_EXPORT = {
  name: "",
  blobProviderId: "",
  schedule: "daily",
  pathPrefix: "cost-exports",
  enabled: true,
  startFrom: null,
} as const;

/** The FOCUS columns the sample shows, with what each one holds. */
const SAMPLE_COLUMNS = [
  { focus: "SubAccountName", meaning: "Team", numeric: false },
  { focus: "ResourceName", meaning: "Agent", numeric: false },
  { focus: "SkuId", meaning: "Model", numeric: false },
  { focus: "BilledCost", meaning: "USD", numeric: true },
];

const SAMPLE_ROWS = [
  {
    team: "Platform",
    agent: "Support agent",
    model: "claude-sonnet-5-5",
    billedCost: "4.82",
  },
  {
    team: "Platform",
    agent: "Code review agent",
    model: "claude-opus-5-5",
    billedCost: "11.30",
  },
  {
    team: "Sales",
    agent: "Lead research agent",
    model: "claude-haiku-5-5",
    billedCost: "0.94",
  },
];
