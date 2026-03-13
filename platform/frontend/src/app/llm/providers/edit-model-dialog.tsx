"use client";

import type { ModelInputModality, ModelOutputModality } from "@shared";
import { RotateCcw } from "lucide-react";
import Image from "next/image";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { PROVIDER_CONFIG } from "@/components/chat-api-key-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { MultiSelect } from "@/components/ui/multi-select";
import { type ModelWithApiKeys, useUpdateModel } from "@/lib/chat-models.query";

const INPUT_MODALITY_OPTIONS: Array<{
  value: ModelInputModality;
  label: string;
}> = [
  { value: "text", label: "Text" },
  { value: "image", label: "Image" },
  { value: "audio", label: "Audio" },
  { value: "video", label: "Video" },
  { value: "pdf", label: "PDF" },
];

const OUTPUT_MODALITY_OPTIONS: Array<{
  value: ModelOutputModality;
  label: string;
}> = [
  { value: "text", label: "Text" },
  { value: "image", label: "Image" },
  { value: "audio", label: "Audio" },
];

interface EditModelFormValues {
  customPricePerMillionInput: string;
  customPricePerMillionOutput: string;
  inputModalities: string[];
  outputModalities: string[];
}

export function EditModelDialog({
  model,
  open,
  onOpenChange,
}: {
  model: ModelWithApiKeys;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const updateModel = useUpdateModel();
  const providerConfig = PROVIDER_CONFIG[model.provider];
  const fallbackPricing = getFallbackPricing(model);
  const form = useForm<EditModelFormValues>({
    defaultValues: getDefaults(model),
  });

  useEffect(() => {
    if (open) {
      form.reset(getDefaults(model));
    }
  }, [open, model, form]);

  const handleSubmit = async (values: EditModelFormValues) => {
    const inputPrice = values.customPricePerMillionInput.trim() || null;
    const outputPrice = values.customPricePerMillionOutput.trim() || null;

    const result = await updateModel.mutateAsync({
      id: model.id,
      customPricePerMillionInput: inputPrice,
      customPricePerMillionOutput: outputPrice,
      inputModalities: values.inputModalities as ModelInputModality[],
      outputModalities: values.outputModalities as ModelOutputModality[],
    });
    if (result) {
      onOpenChange(false);
    }
  };

  const handleResetPricing = () => {
    form.setValue("customPricePerMillionInput", "");
    form.setValue("customPricePerMillionOutput", "");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit Model</DialogTitle>
          <DialogDescription>
            Update pricing and modality settings for this model.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(handleSubmit)}
            className="space-y-4"
          >
            {/* Read-only: Provider */}
            <div className="space-y-1">
              <span className="text-sm font-medium">Provider</span>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                {providerConfig && (
                  <Image
                    src={providerConfig.icon}
                    alt={providerConfig.name}
                    width={20}
                    height={20}
                    className="rounded dark:invert"
                  />
                )}
                <span>{providerConfig?.name ?? model.provider}</span>
              </div>
            </div>

            {/* Read-only: Model ID */}
            <div className="space-y-1">
              <span className="text-sm font-medium">Model ID</span>
              <p className="text-sm font-mono text-muted-foreground">
                {model.modelId}
              </p>
            </div>

            {/* Pricing */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">
                  Custom Pricing ($/M tokens)
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs gap-1"
                  onClick={handleResetPricing}
                >
                  <RotateCcw className="h-3 w-3" />
                  Reset
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="customPricePerMillionInput"
                  rules={{
                    validate: (v) => {
                      if (!v) return true;
                      const n = parseFloat(v);
                      if (Number.isNaN(n) || n < 0)
                        return "Must be a non-negative number";
                      return true;
                    },
                  }}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Input</FormLabel>
                      <FormControl>
                        <Input placeholder={fallbackPricing.input} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="customPricePerMillionOutput"
                  rules={{
                    validate: (v) => {
                      if (!v) return true;
                      const n = parseFloat(v);
                      if (Number.isNaN(n) || n < 0)
                        return "Must be a non-negative number";
                      return true;
                    },
                  }}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Output</FormLabel>
                      <FormControl>
                        <Input
                          placeholder={fallbackPricing.output}
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </div>

            {/* Input Modalities */}
            <FormField
              control={form.control}
              name="inputModalities"
              rules={{
                validate: (v) =>
                  v.length > 0 || "At least one input modality is required",
              }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Input Modalities</FormLabel>
                  <FormControl>
                    <MultiSelect
                      items={INPUT_MODALITY_OPTIONS}
                      value={field.value}
                      onValueChange={field.onChange}
                      placeholder="Select input modalities..."
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Output Modalities */}
            <FormField
              control={form.control}
              name="outputModalities"
              rules={{
                validate: (v) =>
                  v.length > 0 || "At least one output modality is required",
              }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Output Modalities</FormLabel>
                  <FormControl>
                    <MultiSelect
                      items={OUTPUT_MODALITY_OPTIONS}
                      value={field.value}
                      onValueChange={field.onChange}
                      placeholder="Select output modalities..."
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={updateModel.isPending}>
                {updateModel.isPending ? "Saving..." : "Save Changes"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Compute the non-custom fallback price per million tokens.
 * Mirrors backend's ModelModel.getEffectivePricing tiers 2 & 3.
 */
function getFallbackPricing(model: ModelWithApiKeys): {
  input: string;
  output: string;
} {
  // Tier 2: models.dev synced price (per-token → per-million)
  if (
    model.promptPricePerToken != null &&
    model.completionPricePerToken != null
  ) {
    return {
      input: (parseFloat(model.promptPricePerToken) * 1_000_000).toFixed(2),
      output: (parseFloat(model.completionPricePerToken) * 1_000_000).toFixed(
        2,
      ),
    };
  }
  // Tier 3: default fallback
  const isCheaper = ["-haiku", "-nano", "-mini"].some((p) =>
    model.modelId.toLowerCase().includes(p),
  );
  const price = isCheaper ? "30.00" : "50.00";
  return { input: price, output: price };
}

function getDefaults(model: ModelWithApiKeys): EditModelFormValues {
  return {
    customPricePerMillionInput: model.customPricePerMillionInput ?? "",
    customPricePerMillionOutput: model.customPricePerMillionOutput ?? "",
    inputModalities: model.inputModalities ?? [],
    outputModalities: model.outputModalities ?? [],
  };
}
