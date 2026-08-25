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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  type EvalSuite,
  useCreateEvalSuite,
  useUpdateEvalSuite,
} from "@/lib/evals/eval.query";

/** The fields the dialog needs; detail pages fetch suites without caseCount. */
type EditableSuite = Pick<EvalSuite, "id" | "name" | "description">;

type FormValues = {
  name: string;
  description: string;
};

/** Create (no `suite`) or rename/re-describe (`suite` set) an eval suite. */
export function EvalSuiteDialog({
  open,
  onOpenChange,
  suite,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  suite?: EditableSuite | null;
  onCreated?: (suite: EditableSuite) => void;
}) {
  const createSuite = useCreateEvalSuite();
  const updateSuite = useUpdateEvalSuite();
  const isEdit = !!suite;

  const form = useForm<FormValues>({
    defaultValues: { name: "", description: "" },
  });

  useEffect(() => {
    if (open) {
      form.reset({
        name: suite?.name ?? "",
        description: suite?.description ?? "",
      });
    }
  }, [open, suite, form]);

  const onSubmit = form.handleSubmit(async (values) => {
    if (isEdit && suite) {
      await updateSuite.mutateAsync({
        suiteId: suite.id,
        body: {
          name: values.name,
          description: values.description || null,
        },
      });
    } else {
      const created = await createSuite.mutateAsync({
        name: values.name,
        ...(values.description ? { description: values.description } : {}),
      });
      if (created) onCreated?.(created);
    }
    onOpenChange(false);
  });

  const pending = createSuite.isPending || updateSuite.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Edit eval suite" : "New eval suite"}
          </DialogTitle>
          <DialogDescription>
            A suite is a set of test cases you can run against an agent.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="eval-suite-name">Name</Label>
            <Input
              id="eval-suite-name"
              placeholder="e.g. Support answers smoke tests"
              {...form.register("name", { required: true, maxLength: 200 })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="eval-suite-description">Description</Label>
            <Textarea
              id="eval-suite-description"
              placeholder="What this suite checks (optional)"
              rows={3}
              {...form.register("description", { maxLength: 2000 })}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              <span>Cancel</span>
            </Button>
            <Button type="submit" disabled={pending || !form.watch("name")}>
              <span>{isEdit ? "Save" : "Create"}</span>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
