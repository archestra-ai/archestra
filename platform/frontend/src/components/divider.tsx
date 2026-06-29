import { cn } from "@/lib/utils";

function Divider({ className }: { className?: string }) {
  return (
    <div
      className={cn("h-px w-full bg-black/13 dark:bg-white/13", className)}
    />
  );
}

export default Divider;
