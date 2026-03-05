"use client";

import { useEffect } from "react";
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
import { useUpdateConnector } from "@/lib/connector.query";
import { SchedulePicker } from "./schedule-picker";

interface EditConnectorFormValues {
  name: string;
  schedule: string;
}

interface ConnectorItem {
  id: string;
  name: string;
  schedule: string;
}

export function EditConnectorDialog({
  connector,
  open,
  onOpenChange,
}: {
  connector: ConnectorItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const updateConnector = useUpdateConnector();

  const form = useForm<EditConnectorFormValues>({
    defaultValues: {
      name: connector.name,
      schedule: connector.schedule,
    },
  });

  useEffect(() => {
    if (open) {
      form.reset({
        name: connector.name,
        schedule: connector.schedule,
      });
    }
  }, [open, connector, form]);

  const handleSubmit = async (values: EditConnectorFormValues) => {
    const result = await updateConnector.mutateAsync({
      id: connector.id,
      body: {
        name: values.name,
        schedule: values.schedule,
      },
    });
    if (result) {
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit Connector</DialogTitle>
          <DialogDescription>Update the connector settings.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(handleSubmit)}
            className="space-y-4"
          >
            <FormField
              control={form.control}
              name="name"
              rules={{ required: "Name is required" }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input placeholder="Connector name" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <SchedulePicker form={form} name="schedule" />

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={updateConnector.isPending}>
                {updateConnector.isPending ? "Saving..." : "Save Changes"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
