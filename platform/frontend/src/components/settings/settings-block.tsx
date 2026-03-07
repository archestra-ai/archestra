import type { ReactNode } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

interface SettingsBlockProps {
  title: string;
  description?: string;
  control: ReactNode;
  notice?: ReactNode;
  children?: ReactNode;
}

export function SettingsBlock({
  title,
  description,
  control,
  notice,
  children,
}: SettingsBlockProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold leading-none tracking-tight">
              {title}
            </h3>
            {description && (
              <p className="text-sm text-muted-foreground mt-1.5">
                {description}
              </p>
            )}
          </div>
          {control}
        </div>
        {notice && (
          <p className="text-sm text-muted-foreground mt-2">{notice}</p>
        )}
      </CardHeader>
      {children && (
        <CardContent className="pt-6 border-t">{children}</CardContent>
      )}
    </Card>
  );
}
