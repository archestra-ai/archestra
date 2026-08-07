"use client";

import { TEXT_SEARCH_LANGUAGES } from "@archestra/shared";
import type { UseFormReturn } from "react-hook-form";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface TextSearchLanguagePickerProps {
  // biome-ignore lint/suspicious/noExplicitAny: form type is generic across different form schemas
  form: UseFormReturn<any>;
  name: string;
}

/**
 * `simple` is listed first because it is the deliberate "no stemming" choice
 * rather than a language; the rest follow alphabetically.
 */
const LANGUAGE_LABELS: Record<string, string> = {
  simple: "Simple (no stemming)",
};

function labelFor(language: string): string {
  return (
    LANGUAGE_LABELS[language] ??
    language.charAt(0).toUpperCase() + language.slice(1)
  );
}

export function TextSearchLanguagePicker({
  form,
  name,
}: TextSearchLanguagePickerProps) {
  return (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>Keyword Search Language</FormLabel>
          <Select onValueChange={field.onChange} value={field.value}>
            <FormControl>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {TEXT_SEARCH_LANGUAGES.map((language) => (
                <SelectItem key={language} value={language}>
                  {labelFor(language)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FormDescription>
            Pick the language this source is written in, so keyword search
            matches different forms of the same word. Choose Simple for code or
            a mixed-language source. Applies on the next sync.
          </FormDescription>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
