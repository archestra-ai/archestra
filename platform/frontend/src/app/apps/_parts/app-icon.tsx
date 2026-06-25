import {
  AppWindow,
  BarChart3,
  Boxes,
  Calculator,
  FileText,
  Gauge,
  type LucideIcon,
  MessageSquare,
  NotebookPen,
  Receipt,
  Sparkles,
} from "lucide-react";

// Apps have no stored icon, so the gallery derives a stable glyph + pastel tile
// from the app's identity — same input always yields the same tile.
const GLYPHS: LucideIcon[] = [
  AppWindow,
  Calculator,
  FileText,
  MessageSquare,
  Receipt,
  BarChart3,
  Boxes,
  NotebookPen,
  Gauge,
  Sparkles,
];

const TILES = [
  "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  "bg-green-500/10 text-green-600 dark:text-green-400",
  "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  "bg-purple-500/10 text-purple-600 dark:text-purple-400",
  "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
  "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
  "bg-teal-500/10 text-teal-600 dark:text-teal-400",
];

export function deriveAppGlyph(seed: string): {
  Icon: LucideIcon;
  tileClass: string;
} {
  let hash = 0;
  const key = seed || "app";
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  hash = Math.abs(hash);
  return {
    Icon: GLYPHS[hash % GLYPHS.length],
    tileClass: TILES[hash % TILES.length],
  };
}
