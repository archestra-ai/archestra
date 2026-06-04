"use client";

import { useState, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

type House = "gryffindor" | "slytherin" | "ravenclaw" | "hufflepuff";

interface SortingHatModalProps {
  isOpen: boolean;
  toolName: string;
  toolDescription: string;
  onSort: (house: House) => void;
  onSkip: () => void;
}

const HOUSE_COLORS: Record<House, { bg: string; text: string; accent: string }> =
  {
    gryffindor: {
      bg: "bg-red-900/20",
      text: "text-red-300",
      accent: "border-red-500/50",
    },
    slytherin: {
      bg: "bg-green-900/20",
      text: "text-green-300",
      accent: "border-green-500/50",
    },
    ravenclaw: {
      bg: "bg-blue-900/20",
      text: "text-blue-300",
      accent: "border-blue-500/50",
    },
    hufflepuff: {
      bg: "bg-yellow-900/20",
      text: "text-yellow-300",
      accent: "border-yellow-500/50",
    },
  };

const HOUSE_EMOJI: Record<House, string> = {
  gryffindor: "🦁",
  slytherin: "🐍",
  ravenclaw: "🦅",
  hufflepuff: "🦡",
};

/**
 * Sorting Hat Modal — appears on first tool invocation per session.
 * Streams the Hat's monologue token-by-token with a typewriter effect.
 */
export function SortingHatModal({
  isOpen,
  toolName,
  toolDescription,
  onSort,
  onSkip,
}: SortingHatModalProps) {
  const [displayedText, setDisplayedText] = useState("");
  const [isSorting, setIsSorting] = useState(false);
  const [result, setResult] = useState<{
    house: House;
    confidence: number;
  } | null>(null);
  const [isTyping, setIsTyping] = useState(false);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const monologue = generateMonologue(toolName);

  useEffect(() => {
    if (!isOpen || !isSorting || result) return;

    setIsTyping(true);
    let charIndex = 0;

    intervalRef.current = setInterval(() => {
      if (charIndex < monologue.length) {
        setDisplayedText(monologue.slice(0, charIndex + 1));
        charIndex++;
      } else {
        if (intervalRef.current) clearInterval(intervalRef.current);
        setIsTyping(false);
        // Simulate sorting result after monologue
        const house = classifyTool(toolName, toolDescription);
        setResult({ house, confidence: 0.85 });
        onSort(house);
      }
    }, 30); // 30ms per character for streaming effect

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isOpen, isSorting, toolName, toolDescription, result, onSort]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        className={cn(
          "relative max-w-lg w-full mx-4 rounded-xl border-2 p-6 shadow-2xl",
          "bg-gradient-to-b from-amber-950/90 to-stone-950/95",
          result ? HOUSE_COLORS[result.house].accent : "border-amber-500/50",
        )}
      >
        {/* Hat SVG */}
        <div className="flex justify-center mb-4">
          <svg
            viewBox="0 0 100 80"
            className="w-20 h-16 text-amber-600"
            fill="currentColor"
          >
            <path d="M50 5 L20 35 L10 75 L90 75 L80 35 Z" />
            <ellipse cx="50" cy="75" rx="45" ry="8" fill="currentColor" opacity="0.8" />
            <path d="M50 5 L55 20 L45 20 Z" fill="currentColor" opacity="0.6" />
          </svg>
        </div>

        {/* Title */}
        <h2 className="text-xl font-bold text-center text-amber-200 mb-4">
          🎩 The Sorting Hat Speaks...
        </h2>

        {/* Tool Info */}
        <div className="text-center mb-4">
          <span className="text-sm text-amber-400/70">Sorting tool: </span>
          <span className="text-sm font-mono text-amber-200">{toolName}</span>
        </div>

        {/* Monologue */}
        <div className="min-h-[120px] mb-4 p-4 rounded-lg bg-stone-900/50 border border-amber-800/30">
          <p className="text-amber-100/90 whitespace-pre-wrap font-serif italic leading-relaxed">
            {displayedText}
            {isTyping && <span className="animate-pulse">▌</span>}
          </p>
        </div>

        {/* Result */}
        {result && (
          <div
            className={cn(
              "text-center p-3 rounded-lg border mb-4",
              HOUSE_COLORS[result.house].bg,
              HOUSE_COLORS[result.house].accent,
            )}
          >
            <span className="text-3xl mr-2">
              {HOUSE_EMOJI[result.house]}
            </span>
            <span
              className={cn(
                "text-lg font-bold uppercase",
                HOUSE_COLORS[result.house].text,
              )}
            >
              {result.house}
            </span>
            <div className="text-xs text-stone-400 mt-1">
              Confidence: {(result.confidence * 100).toFixed(0)}%
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3 justify-center">
          {!isSorting && !result && (
            <>
              <button
                onClick={() => setIsSorting(true)}
                className="px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded-lg font-medium transition-colors"
              >
                🎩 Begin Sorting
              </button>
              <button
                onClick={onSkip}
                className="px-4 py-2 bg-stone-700 hover:bg-stone-600 text-stone-300 rounded-lg font-medium transition-colors"
              >
                Skip for now
              </button>
            </>
          )}
          {result && (
            <button
              onClick={onSkip}
              className="px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded-lg font-medium transition-colors"
            >
              Continue
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateMonologue(toolName: string): string {
  return `Hmm, yes... "${toolName}"...

*I tap my brim thoughtfully...*

Let me peer into your intentions...

*The Hat's eyes glow with ancient wisdom...*

I sense purpose in this tool...
Let me consult the Four Houses...

*The room falls silent as the Hat concentrates...*`;
}

function classifyTool(name: string, _description: string): House {
  const combined = name.toLowerCase();
  if (
    /delete|remove|drop|destroy|exec|eval|inject|exploit|revoke/.test(combined)
  )
    return "slytherin";
  if (/create|update|write|send|deploy|execute|run|post/.test(combined))
    return "gryffindor";
  if (/analyz|comput|validat|check|verif|pars|transform/.test(combined))
    return "ravenclaw";
  return "hufflepuff";
}
