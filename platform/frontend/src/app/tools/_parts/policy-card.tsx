export function PolicyCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-2 bg-muted/30 border border-border rounded-md p-4 flex flex-row items-center justify-between min-h-[60px]">
      {children}
    </div>
  );
}
