"use client";

import { useFieldArray, useForm } from "react-hook-form";
import { EnvironmentVariablesFormField } from "@/components/environment-variables-form-field";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Form } from "@/components/ui/form";

interface EnvironmentVariable {
  key: string;
  type: "plain_text" | "secret";
  value?: string;
  promptOnInstallation: boolean;
}

interface ConfigureEnvironmentDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (environment: EnvironmentVariable[]) => void;
  serverName: string;
  defaultEnvironment?: EnvironmentVariable[];
}

interface FormValues {
  environment: EnvironmentVariable[];
}

export function ConfigureEnvironmentDialog({
  isOpen,
  onClose,
  onConfirm,
  serverName,
  defaultEnvironment = [],
}: ConfigureEnvironmentDialogProps) {
  const form = useForm<FormValues>({
    defaultValues: {
      environment: defaultEnvironment,
    },
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "environment",
  });

  const handleSubmit = (values: FormValues) => {
    onConfirm(values.environment);
    onClose();
  };

  const handleCancel = () => {
    form.reset();
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleCancel}>
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Configure Environment Variables</DialogTitle>
          <DialogDescription>
            Optionally configure environment variables for{" "}
            <strong>{serverName}</strong>. Choose type (plain text or secret)
            for storage, and optionally enable prompting during installation for
            values that should be provided by each installer.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(handleSubmit)}
            className="space-y-6"
          >
            <EnvironmentVariablesFormField
              control={form.control}
              fields={fields}
              append={append}
              remove={remove}
              fieldNamePrefix="environment"
              form={form}
              showLabel={false}
              showDescription={false}
            />

            <DialogFooter>
              <Button type="button" variant="outline" onClick={handleCancel}>
                Cancel
              </Button>
              <Button type="submit">Add to Registry</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
