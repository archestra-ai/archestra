"use client";

import type { UseFormReturn } from "react-hook-form";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";

interface WebCrawlerConfigFieldsProps {
  // biome-ignore lint/suspicious/noExplicitAny: form type is generic across different connector schemas
  form: UseFormReturn<any>;
  prefix?: string;
}

export function WebCrawlerConfigFields({
  form,
  prefix = "config",
}: WebCrawlerConfigFieldsProps) {
  return (
    <div className="space-y-4">
      <FormField
        control={form.control}
        name={`${prefix}.includePathPrefixes`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Include Path Prefixes (optional)</FormLabel>
            <FormControl>
              <Input
                placeholder="/docs/, /guides/"
                {...field}
                value={formatArrayValue(field.value)}
              />
            </FormControl>
            <FormDescription>
              Comma-separated paths to crawl. Defaults to the start URL&apos;s
              path.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name={`${prefix}.excludePathPatterns`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Exclude Path Patterns (optional)</FormLabel>
            <FormControl>
              <Input
                placeholder="/search, /archive/.*"
                {...field}
                value={formatArrayValue(field.value)}
              />
            </FormControl>
            <FormDescription>
              Comma-separated regular expressions matched against path and
              query.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name={`${prefix}.contentSelector`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Content Selector (optional)</FormLabel>
            <FormControl>
              <Input
                placeholder="main, article, .document"
                {...field}
                value={(field.value as string | undefined) ?? ""}
              />
            </FormControl>
            <FormDescription>
              CSS selector for the page content root. Leave empty to use the
              default document selectors.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name={`${prefix}.excludeSelectors`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Exclude Selectors (optional)</FormLabel>
            <FormControl>
              <Input
                placeholder=".sidebar, .breadcrumb, .toc"
                {...field}
                value={formatArrayValue(field.value)}
              />
            </FormControl>
            <FormDescription>
              Comma-separated CSS selectors to remove before extracting text.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <NumberField
          form={form}
          name={`${prefix}.maxPages`}
          label="Max Pages"
          placeholder="250"
          description="Stops the crawl after this many pages."
          min={1}
        />
        <NumberField
          form={form}
          name={`${prefix}.maxDepth`}
          label="Max Depth"
          placeholder="3"
          description="Maximum link depth from the start URL."
        />
        <NumberField
          form={form}
          name={`${prefix}.batchSize`}
          label="Batch Size"
          placeholder="25"
          description="Documents yielded per sync batch."
          min={1}
        />
        <NumberField
          form={form}
          name={`${prefix}.requestDelayMs`}
          label="Request Delay"
          placeholder="0"
          description="Delay between requests, in milliseconds."
        />
      </div>

      <FormField
        control={form.control}
        name={`${prefix}.userAgent`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>User Agent (optional)</FormLabel>
            <FormControl>
              <Input
                placeholder="Archestra Web Crawler"
                {...field}
                value={(field.value as string | undefined) ?? ""}
              />
            </FormControl>
            <FormDescription>
              Custom User-Agent header for crawl requests.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}

function NumberField({
  form,
  name,
  label,
  placeholder,
  description,
  min = 0,
}: {
  // biome-ignore lint/suspicious/noExplicitAny: form type is generic across different connector schemas
  form: UseFormReturn<any>;
  name: string;
  label: string;
  placeholder: string;
  description: string;
  min?: number;
}) {
  return (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label} (optional)</FormLabel>
          <FormControl>
            <Input
              type="number"
              min={min}
              placeholder={placeholder}
              {...field}
              value={(field.value as number | undefined) ?? ""}
              onChange={(event) =>
                field.onChange(
                  event.target.value === ""
                    ? undefined
                    : Number(event.target.value),
                )
              }
            />
          </FormControl>
          <FormDescription>{description}</FormDescription>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

function formatArrayValue(value: unknown): string {
  return Array.isArray(value) ? value.join(", ") : ((value as string) ?? "");
}
