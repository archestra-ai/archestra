"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { cn } from "@/lib/utils";

type PatronusForm =
  | "otter"
  | "stag"
  | "doe"
  | "hare"
  | "hound"
  | "tabby cat"
  | "fox"
  | "wolf"
  | "owl"
  | "eagle"
  | "unicorn"
  | "phoenix";

interface PatronusPickerProps {
  currentForm: PatronusForm;
  userId: string;
  onSelect: (form: PatronusForm) => void;
}

const PATRONUS_CONFIG: Record<
  PatronusForm,
  { emoji: string; color: string; description: string }
> = {
  otter: {
    emoji: "🦦",
    color: "text-blue-300",
    description: "Playful and clever, the otter represents joy and curiosity",
  },
  stag: {
    emoji: "🦌",
    color: "text-amber-300",
    description: "Noble and protective, the stag embodies leadership",
  },
  doe: {
    emoji: "🦌",
    color: "text-pink-200",
    description: "Gentle and nurturing, the doe symbolizes love and sacrifice",
  },
  hare: {
    emoji: "🐇",
    color: "text-green-300",
    description: "Swift and alert, the hare represents quick thinking",
  },
  hound: {
    emoji: "🐕",
    color: "text-orange-300",
    description: "Loyal and fierce, the hound embodies unwavering dedication",
  },
  "tabby cat": {
    emoji: "🐱",
    color: "text-stone-300",
    description: "Independent and mysterious, the cat represents intuition",
  },
  fox: {
    emoji: "🦊",
    color: "text-red-300",
    description: "Clever and adaptable, the fox embodies resourcefulness",
  },
  wolf: {
    emoji: "🐺",
    color: "text-slate-300",
    description: "Fierce and loyal, the wolf represents pack strength",
  },
  owl: {
    emoji: "🦉",
    color: "text-amber-200",
    description: "Wise and watchful, the owl embodies ancient knowledge",
  },
  eagle: {
    emoji: "🦅",
    color: "text-sky-300",
    description: "Majestic and far-seeing, the eagle represents vision",
  },
  unicorn: {
    emoji: "🦄",
    color: "text-purple-200",
    description: "Pure and magical, the unicorn embodies untamed power",
  },
  phoenix: {
    emoji: "🔥",
    color: "text-orange-200",
    description: "Reborn from ashes, the phoenix represents resilience",
  },
};

/**
 * Patronus Picker — allows users to select their Patronus form.
 * Includes a small canvas animation of the selected form.
 */
export function PatronusPicker({
  currentForm,
  userId,
  onSelect,
}: PatronusPickerProps) {
  const [selectedForm, setSelectedForm] = useState<PatronusForm>(currentForm);
  const [isAnimating, setIsAnimating] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const handleSelect = useCallback(
    (form: PatronusForm) => {
      setSelectedForm(form);
      setIsAnimating(true);
      onSelect(form);
      // Stop animation after 2 seconds
      setTimeout(() => setIsAnimating(false), 2000);
    },
    [onSelect],
  );

  // Canvas animation for the selected Patronus
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !isAnimating) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let frame = 0;
    let animationId: number;

    const animate = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Draw a glowing orb representing the Patronus
      const centerX = canvas.width / 2;
      const centerY = canvas.height / 2;
      const radius = 20 + Math.sin(frame * 0.1) * 5;

      // Outer glow
      const gradient = ctx.createRadialGradient(
        centerX,
        centerY,
        0,
        centerX,
        centerY,
        radius * 2,
      );
      gradient.addColorStop(0, "rgba(147, 197, 253, 0.8)");
      gradient.addColorStop(0.5, "rgba(147, 197, 253, 0.3)");
      gradient.addColorStop(1, "rgba(147, 197, 253, 0)");

      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(centerX, centerY, radius * 2, 0, Math.PI * 2);
      ctx.fill();

      // Inner core
      ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
      ctx.beginPath();
      ctx.arc(centerX, centerY, radius / 2, 0, Math.PI * 2);
      ctx.fill();

      // Sparkles
      for (let i = 0; i < 6; i++) {
        const angle = (frame * 0.02 + (i * Math.PI) / 3);
        const sparkleX = centerX + Math.cos(angle) * radius * 1.5;
        const sparkleY = centerY + Math.sin(angle) * radius * 1.5;
        const sparkleSize = 1 + Math.sin(frame * 0.1 + i) * 0.5;

        ctx.fillStyle = `rgba(255, 255, 255, ${0.5 + Math.sin(frame * 0.05 + i) * 0.3})`;
        ctx.beginPath();
        ctx.arc(sparkleX, sparkleY, sparkleSize, 0, Math.PI * 2);
        ctx.fill();
      }

      frame++;
      animationId = requestAnimationFrame(animate);
    };

    animate();
    return () => cancelAnimationFrame(animationId);
  }, [isAnimating]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        {/* Canvas animation */}
        <div className="relative">
          <canvas
            ref={canvasRef}
            width={120}
            height={120}
            className="rounded-lg bg-stone-900/50 border border-stone-700"
          />
          <div className="absolute inset-0 flex items-center justify-center text-4xl pointer-events-none">
            {PATRONUS_CONFIG[selectedForm].emoji}
          </div>
        </div>

        {/* Current form info */}
        <div>
          <h3 className={cn("font-bold text-lg", PATRONUS_CONFIG[selectedForm].color)}>
            {PATRONUS_CONFIG[selectedForm].emoji}{" "}
            {selectedForm.charAt(0).toUpperCase() + selectedForm.slice(1)}
          </h3>
          <p className="text-sm text-stone-400">
            {PATRONUS_CONFIG[selectedForm].description}
          </p>
          <p className="text-xs text-stone-500 mt-1">
            Deterministic for user: {userId.slice(0, 8)}...
          </p>
        </div>
      </div>

      {/* Picker grid */}
      <div className="grid grid-cols-4 gap-2">
        {(Object.keys(PATRONUS_CONFIG) as PatronusForm[]).map((form) => (
          <button
            key={form}
            onClick={() => handleSelect(form)}
            className={cn(
              "p-2 rounded-lg border transition-all text-center",
              selectedForm === form
                ? "border-blue-500 bg-blue-500/10 ring-1 ring-blue-500/30"
                : "border-stone-700 bg-stone-800/50 hover:border-stone-500",
            )}
          >
            <span className="text-xl">{PATRONUS_CONFIG[form].emoji}</span>
            <div className="text-xs text-stone-300 mt-1 capitalize">{form}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
