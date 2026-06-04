"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

interface GoldenSnitchLoaderProps {
  isActive: boolean;
  progress?: number;
  size?: "sm" | "md" | "lg";
  className?: string;
}

/**
 * Golden Snitch Loader — replaces the default spinner for Gryffindor-sorted tools.
 * Renders a small golden snitch with trailing sparkles at 60fps.
 */
export function GoldenSnitchLoader({
  isActive,
  progress = 0,
  size = "md",
  className,
}: GoldenSnitchLoaderProps) {
  const [frame, setFrame] = useState(0);
  const [position, setPosition] = useState({ x: 0, y: 0 });

  const sizeMap = {
    sm: { width: 24, height: 24 },
    md: { width: 32, height: 32 },
    lg: { width: 48, height: 48 },
  };

  useEffect(() => {
    if (!isActive) return;

    let animationFrame: number;
    let lastTime = performance.now();

    const animate = (currentTime: number) => {
      const delta = currentTime - lastTime;

      // Target 60fps (16.67ms per frame)
      if (delta >= 16) {
        setFrame((prev) => (prev + 1) % 360);
        setPosition({
          x: Math.sin(frame * 0.05) * 8,
          y: Math.cos(frame * 0.07) * 5,
        });
        lastTime = currentTime;
      }

      animationFrame = requestAnimationFrame(animate);
    };

    animationFrame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationFrame);
  }, [isActive, frame]);

  if (!isActive) return null;

  const { width, height } = sizeMap[size];

  return (
    <div
      className={cn("inline-flex items-center gap-1", className)}
      role="status"
      aria-label="Tool call in progress"
    >
      <svg
        width={width}
        height={height}
        viewBox="0 0 32 32"
        className="drop-shadow-lg"
        style={{ filter: "drop-shadow(0 0 6px rgba(255, 215, 0, 0.6))" }}
      >
        {/* Snitch body */}
        <ellipse
          cx={16 + position.x}
          cy={16 + position.y}
          rx={4}
          ry={3}
          fill="url(#snitchGradient)"
          className="animate-pulse"
        />
        {/* Left wing */}
        <ellipse
          cx={16 + position.x - 6}
          cy={16 + position.y - 2}
          rx={5}
          ry={2}
          fill="rgba(255,255,255,0.7)"
          transform={`rotate(${Math.sin(frame * 0.2) * 15} ${16 + position.x - 6} ${16 + position.y - 2})`}
        />
        {/* Right wing */}
        <ellipse
          cx={16 + position.x + 6}
          cy={16 + position.y - 2}
          rx={5}
          ry={2}
          fill="rgba(255,255,255,0.7)"
          transform={`rotate(${-Math.sin(frame * 0.2) * 15} ${16 + position.x + 6} ${16 + position.y - 2})`}
        />
        {/* Sparkle trail */}
        {[0, 1, 2, 3, 4].map((i) => (
          <circle
            key={i}
            cx={16 + position.x - i * 3 + Math.sin(frame * 0.1 + i) * 2}
            cy={16 + position.y + i * 2 + Math.cos(frame * 0.1 + i) * 2}
            r={1.5 - i * 0.3}
            fill={`rgba(255, 215, 0, ${1 - i * 0.2})`}
          />
        ))}
        <defs>
          <radialGradient id="snitchGradient">
            <stop offset="0%" stopColor="#FFD700" />
            <stop offset="100%" stopColor="#B8860B" />
          </radialGradient>
        </defs>
      </svg>
      <span className="text-xs text-amber-400 font-medium">
        {progress > 0 ? `${Math.round(progress * 100)}%` : "In flight..."}
      </span>
    </div>
  );
}

/**
 * Default spinner — used for non-Gryffindor tools.
 * This is the existing loader for reference/comparison.
 */
export function DefaultLoader({ className }: { className?: string }) {
  return (
    <div className={cn("inline-flex items-center gap-2", className)}>
      <svg
        width={16}
        height={16}
        viewBox="0 0 16 16"
        className="animate-spin text-stone-400"
      >
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          opacity="0.3"
        />
        <path
          d="M8 2a6 6 0 0 1 6 6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
      <span className="text-xs text-stone-400">Loading...</span>
    </div>
  );
}
