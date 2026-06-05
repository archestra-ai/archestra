"use client";

import { SparklesIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SettingsCardHeader } from "@/components/settings/settings-block";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const PATRONUS_FORMS = [
  "stag",
  "doe",
  "otter",
  "hare",
  "lynx",
  "phoenix",
  "swan",
  "terrier",
  "thestral",
  "wildcat",
] as const;

const STORAGE_KEY = "archestra-patronus-form";

export function PatronusPicker() {
  const [form, setForm] = useState<(typeof PATRONUS_FORMS)[number]>("stag");

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (PATRONUS_FORMS.some((candidate) => candidate === stored)) {
      setForm(stored as (typeof PATRONUS_FORMS)[number]);
    }
  }, []);

  const handleChange = (value: string) => {
    if (!PATRONUS_FORMS.some((candidate) => candidate === value)) return;
    setForm(value as (typeof PATRONUS_FORMS)[number]);
    window.localStorage.setItem(STORAGE_KEY, value);
  };

  return (
    <Card>
      <SettingsCardHeader
        title="Patronus"
        description="Choose the Patronus form shown in your tool authorization flow."
        action={
          <Select value={form} onValueChange={handleChange}>
            <SelectTrigger aria-label="Patronus form" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PATRONUS_FORMS.map((candidate) => (
                <SelectItem key={candidate} value={candidate}>
                  {candidate}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <CardContent className="border-t pt-4">
        <PatronusCanvas form={form} />
      </CardContent>
    </Card>
  );
}

function PatronusCanvas({ form }: { form: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    let frame = 0;
    let animationId = 0;

    const draw = () => {
      const width = canvas.width;
      const height = canvas.height;
      context.clearRect(0, 0, width, height);
      context.fillStyle = "rgba(125, 211, 252, 0.08)";
      context.fillRect(0, 0, width, height);
      context.strokeStyle = "rgba(186, 230, 253, 0.85)";
      context.fillStyle = "rgba(240, 249, 255, 0.85)";
      context.lineWidth = 2;

      const centerX = width / 2;
      const centerY = height / 2 + Math.sin(frame / 24) * 3;
      context.beginPath();
      context.ellipse(centerX, centerY, 42, 18, 0, 0, Math.PI * 2);
      context.stroke();
      context.beginPath();
      context.arc(centerX + 36, centerY - 10, 12, 0, Math.PI * 2);
      context.stroke();
      context.beginPath();
      context.moveTo(centerX - 16, centerY + 16);
      context.lineTo(centerX - 28, centerY + 34);
      context.moveTo(centerX + 12, centerY + 16);
      context.lineTo(centerX + 24, centerY + 34);
      context.stroke();
      context.font = "12px sans-serif";
      context.fillText(form, 12, height - 12);
      context.fill();

      frame += 1;
      animationId = window.requestAnimationFrame(draw);
    };

    draw();
    return () => window.cancelAnimationFrame(animationId);
  }, [form]);

  return (
    <div className="flex items-center gap-4">
      <canvas
        ref={canvasRef}
        width={220}
        height={92}
        className="h-24 w-full max-w-64 rounded-md border bg-muted/30"
        aria-label={`${form} Patronus preview`}
      />
      <SparklesIcon className="size-5 text-sky-300" aria-hidden="true" />
    </div>
  );
}
