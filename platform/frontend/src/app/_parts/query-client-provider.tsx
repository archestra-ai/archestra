"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

export const ArchestraQueryClientProvider = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // With SSR, we want to set some default staleTime
            // above 0 to avoid refetching immediately on the client
            staleTime: 60 * 1_000,
            throwOnError: true, // errors to be thrown in the render phase and propagate to the nearest error boundary
            retry: 2,
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};
