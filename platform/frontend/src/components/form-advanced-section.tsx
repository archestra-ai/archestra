"use client";

import { type ReactNode, useState } from "react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

/** Keep permission and label drafts mounted when Advanced is collapsed. */
export function FormAdvancedSection({ children }: { children: ReactNode }) {
  const [value, setValue] = useState("");
  return (
    <Accordion type="single" collapsible value={value} onValueChange={setValue}>
      <AccordionItem value="advanced">
        <AccordionTrigger>Advanced</AccordionTrigger>
        <AccordionContent forceMount hidden={value !== "advanced"}>
          <div className="space-y-5">{children}</div>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
