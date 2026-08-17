"use client";

import { Plus, Trash2 } from "lucide-react";
import { type UseFormReturn, useFieldArray } from "react-hook-form";
import { Button } from "@/components/ui/button";
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

const COLUMN_FORMATS = [
  { value: "text", label: "Text" },
  { value: "boolean", label: "Yes / no" },
  { value: "date", label: "Date" },
  { value: "number", label: "Number" },
  { value: "list", label: "List" },
  { value: "exact_quote", label: "Exact quote" },
] as const;

interface ColumnFormValue {
  /**
   * The key this column already has, when editing an existing analysis. Cells
   * are addressed by key, so an edited column has to keep the one it was
   * created with — deriving a fresh key from a renamed column would orphan
   * every answer already written against it. Absent for a newly added column,
   * which gets one derived from its name.
   */
  key?: string;
  name: string;
  prompt: string;
  format: (typeof COLUMN_FORMATS)[number]["value"];
}

export interface CreateAnalysisFormValues {
  name: string;
  agentId: string;
  columns: ColumnFormValue[];
}

export const EMPTY_COLUMN: ColumnFormValue = {
  name: "",
  prompt: "",
  format: "text",
};

/**
 * The column editor. A "column" is a question asked of every source, so the
 * heading carries a line of explanation — on its own the word describes the
 * output shape rather than what the user is being asked to write.
 */
export function AnalysisColumnsField({
  form,
}: {
  form: UseFormReturn<CreateAnalysisFormValues>;
}) {
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "columns",
  });

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <FormLabel className="text-base">Columns</FormLabel>
          <p className="text-muted-foreground text-sm">
            Each column is one question, asked of every source you add. The
            answers become that column's cells — so "Data residency region" with
            the question "Where is customer data stored?" gives you one column
            of regions across the whole set.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => append({ ...EMPTY_COLUMN })}
        >
          <Plus className="mr-1 h-3 w-3" />
          <span>Add column</span>
        </Button>
      </div>

      {fields.map((fieldItem, index) => (
        <div key={fieldItem.id} className="space-y-3 rounded-md border p-3">
          <div className="flex items-start gap-2">
            <FormField
              control={form.control}
              name={`columns.${index}.name`}
              rules={{ required: "Column name is required" }}
              render={({ field }) => (
                <FormItem className="flex-1">
                  <FormControl>
                    <Input placeholder="Column name" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name={`columns.${index}.format`}
              render={({ field }) => (
                <FormItem className="w-40">
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {COLUMN_FORMATS.map((format) => (
                        <SelectItem key={format.value} value={format.value}>
                          {format.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormItem>
              )}
            />
            {fields.length > 1 && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove column ${index + 1}`}
                onClick={() => remove(index)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
          <FormField
            control={form.control}
            name={`columns.${index}.prompt`}
            rules={{ required: "A question is required" }}
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <Textarea
                    rows={2}
                    placeholder="What should be extracted from each source for this column?"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
      ))}
    </div>
  );
}
