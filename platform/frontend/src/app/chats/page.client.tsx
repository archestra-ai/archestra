"use client";

import type { GetChatsResponses } from "@shared/api-client";
import { Copy } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { toast } from "sonner";
import { LoadingSpinner } from "@/components/loading";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useChats } from "@/lib/chat.query";
import { formatDate } from "@/lib/utils";
import { ErrorBoundary } from "../_parts/error-boundary";

export default function ChatsPage({
  initialData,
}: {
  initialData?: GetChatsResponses["200"];
}) {
  return (
    <div className="container mx-auto p-6">
      <h1 className="text-3xl font-bold mb-6">Chats</h1>
      <ErrorBoundary>
        <Suspense fallback={<LoadingSpinner />}>
          <Chats initialData={initialData} />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

function Chats({ initialData }: { initialData?: GetChatsResponses["200"] }) {
  const { data: chats = [] } = useChats({ initialData });

  if (chats == null || chats.length === 0) {
    return <p className="text-muted-foreground">No chats found</p>;
  }

  return (
    <div className="w-full overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            {[
              "ID",
              "Agent",
              "Interactions",
              "Created",
              "Updated",
              "Actions",
            ].map((header) => (
              <TableHead className="font-bold" key={header}>
                {header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {chats.map((chat) => (
            <TableRow key={chat.id}>
              <TableCell
                onClick={() => {
                  navigator.clipboard.writeText(chat.id);
                  toast.success("ID copied to clipboard");
                }}
              >
                <span
                  className={`font-medium cursor-pointer group relative pr-8`}
                >
                  {chat.id}
                  <Copy
                    className={`w-4 h-4 hidden group-hover:block absolute top-1/2 right-0 -translate-y-1/2`}
                  />
                </span>
              </TableCell>
              <TableCell
                onClick={() => {
                  navigator.clipboard.writeText(chat.agentId);
                  toast.success("Agent ID copied to clipboard");
                }}
              >
                <span
                  className={`font-medium cursor-pointer group relative pr-8`}
                >
                  {chat.agentId}
                  <Copy
                    className={`w-4 h-4 hidden group-hover:block absolute top-1/2 right-0 -translate-y-1/2`}
                  />
                </span>
              </TableCell>
              <TableCell>{chat.interactions.length}</TableCell>
              <TableCell>{formatDate({ date: chat.createdAt })}</TableCell>
              <TableCell>{formatDate({ date: chat.updatedAt })}</TableCell>
              <TableCell>
                <Button variant="outline" asChild>
                  <Link href={`/chats/${chat.id}`}>Details</Link>
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
