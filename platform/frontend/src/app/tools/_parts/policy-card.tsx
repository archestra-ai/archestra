import { Card } from "@/components/ui/card";

export function PolicyCard({ children }: { children: React.ReactNode }) {
  return (
    <Card className="mt-2 bg-muted p-4 flex flex-row items-center justify-between">
      {children}
    </Card>
  );
}
