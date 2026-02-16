"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  Carousel,
  type CarouselApi,
  CarouselContent,
  CarouselItem,
} from "@/components/ui/carousel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface LastStepAction {
  label: string;
  disabled?: boolean;
  loading?: boolean;
  onClick: () => void;
}

interface SetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  steps: React.ReactNode[];
  lastStepAction?: LastStepAction;
  /** Per-step gating: if provided, `canProceed(stepIndex)` must return true to enable the Next button */
  canProceed?: (stepIndex: number) => boolean;
}

export function SetupDialog({
  open,
  onOpenChange,
  title,
  description,
  steps,
  lastStepAction,
  canProceed,
}: SetupDialogProps) {
  const [api, setApi] = React.useState<CarouselApi>();
  const [current, setCurrent] = React.useState(0);

  React.useEffect(() => {
    if (!api) return;
    setCurrent(api.selectedScrollSnap());
    api.on("select", () => {
      setCurrent(api.selectedScrollSnap());
    });
  }, [api]);

  const isFirst = current === 0;
  const isLast = current === steps.length - 1;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[85vh] max-h-[85vh] flex flex-col gap-0 p-0 overflow-hidden max-w-[1400px]! w-[80vw]">
        <DialogHeader className="px-6 pt-6 pb-4">
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        <div className="flex-1 min-h-0 [&_[data-slot=carousel-content]]:h-full">
          <Carousel
            setApi={setApi}
            opts={{ watchDrag: false }}
            className="h-full"
          >
            <CarouselContent className="h-full pb-6">
              {steps.map((step, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: items are static
                <CarouselItem key={index} className="h-full">
                  <div className="flex h-full flex-col overflow-y-auto px-6">
                    {step}
                  </div>
                </CarouselItem>
              ))}
            </CarouselContent>
          </Carousel>
        </div>

        <div className="flex items-center justify-between border-t px-6 py-4">
          <div className="text-sm text-muted-foreground">
            Step {current + 1} of {steps.length}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => api?.scrollPrev()}
              disabled={isFirst}
            >
              <ChevronLeft className="mr-1 h-4 w-4" />
              Back
            </Button>
            {isLast && lastStepAction && (
              <Button
                size="sm"
                disabled={lastStepAction.disabled || lastStepAction.loading}
                onClick={lastStepAction.onClick}
              >
                {lastStepAction.label}
              </Button>
            )}
            {isLast && !lastStepAction && (
              <Button size="sm" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            )}
            {!isLast && (
              <Button
                size="sm"
                onClick={() => api?.scrollNext()}
                disabled={canProceed ? !canProceed(current) : false}
              >
                Next
                <ChevronRight className="ml-1 h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
