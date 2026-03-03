"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCreateConnector } from "@/lib/connector.query";
import { ConfluenceConfigFields } from "./confluence-config-fields";
import { JiraConfigFields } from "./jira-config-fields";
import { SchedulePicker } from "./schedule-picker";

interface CreateConnectorFormValues {
  name: string;
  connectorType: "jira" | "confluence";
  config: Record<string, unknown>;
  email: string;
  apiToken: string;
  schedule: string;
}

export function CreateConnectorDialog({
  knowledgeGraphId,
  open,
  onOpenChange,
}: {
  knowledgeGraphId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createConnector = useCreateConnector(knowledgeGraphId);
  const [step, setStep] = useState(0);

  const form = useForm<CreateConnectorFormValues>({
    defaultValues: {
      name: "",
      connectorType: "jira",
      config: { type: "jira", isCloud: true },
      email: "",
      apiToken: "",
      schedule: "0 */6 * * *",
    },
  });

  const connectorType = form.watch("connectorType");

  const handleSubmit = async (values: CreateConnectorFormValues) => {
    const result = await createConnector.mutateAsync({
      name: values.name,
      connectorType: values.connectorType,
      config: values.config,
      credentials: {
        email: values.email,
        apiToken: values.apiToken,
      },
      schedule: values.schedule,
    });
    if (result) {
      form.reset();
      setStep(0);
      onOpenChange(false);
    }
  };

  const handleClose = (open: boolean) => {
    if (!open) {
      form.reset();
      setStep(0);
    }
    onOpenChange(open);
  };

  const steps = [
    { title: "Type & Name", description: "Choose connector type and name" },
    { title: "Configuration", description: "Configure connector settings" },
    { title: "Credentials", description: "Add authentication details" },
    { title: "Schedule", description: "Set sync schedule" },
  ];

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Connector - {steps[step].title}</DialogTitle>
          <DialogDescription>{steps[step].description}</DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 mb-4">
          {steps.map((s, i) => (
            <div
              key={s.title}
              className={`h-1 flex-1 rounded-full ${
                i <= step ? "bg-primary" : "bg-muted"
              }`}
            />
          ))}
        </div>

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(handleSubmit)}
            className="space-y-4"
          >
            {step === 0 && (
              <>
                <FormField
                  control={form.control}
                  name="name"
                  rules={{ required: "Name is required" }}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Name</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="Engineering Jira Connector"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="connectorType"
                  rules={{ required: "Connector type is required" }}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Connector Type</FormLabel>
                      <Select
                        onValueChange={(value) => {
                          field.onChange(value);
                          form.setValue("config", {
                            type: value,
                            isCloud: true,
                          });
                        }}
                        defaultValue={field.value}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select connector type" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="jira">Jira</SelectItem>
                          <SelectItem value="confluence">Confluence</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </>
            )}

            {step === 1 && connectorType === "jira" && (
              <JiraConfigFields form={form} />
            )}
            {step === 1 && connectorType === "confluence" && (
              <ConfluenceConfigFields form={form} />
            )}

            {step === 2 && (
              <>
                <FormField
                  control={form.control}
                  name="email"
                  rules={{ required: "Email is required" }}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email</FormLabel>
                      <FormControl>
                        <Input
                          type="email"
                          placeholder="user@example.com"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="apiToken"
                  rules={{ required: "API token is required" }}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>API Token</FormLabel>
                      <FormControl>
                        <Input
                          type="password"
                          placeholder="Your API token"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </>
            )}

            {step === 3 && <SchedulePicker form={form} name="schedule" />}

            <DialogFooter>
              {step > 0 && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setStep(step - 1)}
                >
                  Back
                </Button>
              )}
              {step < steps.length - 1 ? (
                <Button type="button" onClick={() => setStep(step + 1)}>
                  Next
                </Button>
              ) : (
                <Button type="submit" disabled={createConnector.isPending}>
                  {createConnector.isPending
                    ? "Creating..."
                    : "Create Connector"}
                </Button>
              )}
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
