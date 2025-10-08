"use client";

import type { GetAgentsResponses, GetChatsResponses } from "@shared/api-client";
import { uniq } from "lodash-es";
import { Copy } from "lucide-react";
import Link from "next/link";
import { Suspense, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { LoadingSpinner } from "@/components/loading";
import { TruncatedText } from "@/components/truncated-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAgents } from "@/lib/agent.query";
import { useChats } from "@/lib/chat.query";
import {
  toolNamesRefusedForChat,
  toolNamesUsedForChat,
} from "@/lib/chat.utils";
import { cn, formatDate } from "@/lib/utils";
import { ErrorBoundary } from "../_parts/error-boundary";

export default function ChatsPage({
  initialData,
}: {
  initialData?: {
    chats: GetChatsResponses["200"];
    agents: GetAgentsResponses["200"];
  };
}) {
  return (
    <div className="container mx-auto p-6 pt-0 mt-6 relative">
      <h1 className="text-3xl font-bold mb-6">Chats</h1>
      <ErrorBoundary>
        <Suspense fallback={<LoadingSpinner />}>
          <Chats initialData={initialData} />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

type ColumnId =
  | "id"
  | "agentId"
  | "agentName"
  | "interactions"
  | "toolsUsed"
  | "toolsRefused"
  | "firstMessage"
  | "lastMessage"
  | "createdAt"
  | "actions";

function getColumnsWithoutOrder({
  agents,
}: {
  agents: GetAgentsResponses["200"];
}): Record<
  ColumnId,
  {
    label: string;
    render: (chat: GetChatsResponses["200"][number]) => React.ReactNode;
    onClick?: (chat: GetChatsResponses["200"][number]) => void;
    cellClassName?: string;
  }
> {
  return {
    id: {
      label: "ID",
      onClick: (chat) => {
        navigator.clipboard.writeText(chat.id);
        toast.success("ID copied to clipboard");
      },
      render: (chat) => (
        <div className="pr-6 cursor-pointer">
          <span className="font-medium">{chat.id}</span>
          <Copy className="w-4 h-4 hidden group-hover:block absolute top-1/2 right-2 -translate-y-1/2" />
        </div>
      ),
    },
    agentId: {
      label: "Agent ID",
      onClick: (chat) => {
        navigator.clipboard.writeText(chat.agentId);
        toast.success("Agent ID copied to clipboard");
      },
      render: (chat) => (
        <div className="pr-6 cursor-pointer">
          <span className="font-medium">{chat.agentId}</span>
          <Copy className="w-4 h-4 hidden group-hover:block absolute top-1/2 right-2 -translate-y-1/2" />
        </div>
      ),
    },
    agentName: {
      label: "Agent name",
      render: (chat) => {
        const text =
          agents.find((agent) => agent.id === chat.agentId)?.name ?? "Unknown";
        return <TruncatedText message={text} />;
      },
    },
    interactions: {
      label: "Number of messages",
      render: (chat) => chat.interactions.length,
    },
    toolsUsed: {
      label: "Tools used",
      render: (chat) => {
        return (
          <>
            {toolNamesUsedForChat(chat).map((toolName) => (
              <Badge key={toolName} className="mt-2">
                {toolName}
              </Badge>
            ))}
          </>
        );
      },
    },
    toolsRefused: {
      label: "Tools refused",
      render: (chat) => {
        return (
          <>
            {toolNamesRefusedForChat(chat).map((toolName) => (
              <Badge key={toolName} className="mt-2" variant="destructive">
                {toolName}
              </Badge>
            ))}
          </>
        );
      },
    },
    firstMessage: {
      label: "First user message",
      render: (chat) => <TruncatedText message={findFirstUserMessage(chat)} />,
    },
    lastMessage: {
      label: "Last user message",
      render: (chat) => <TruncatedText message={findLastUserMessage(chat)} />,
    },
    createdAt: {
      label: "Date",
      render: (chat) => formatDate({ date: chat.createdAt }),
    },
    actions: {
      label: "Actions",
      render: (chat) => (
        <Button variant="outline" asChild>
          <Link href={`/chats/${chat.id}`}>Details</Link>
        </Button>
      ),
      cellClassName: "text-right",
    },
  };
}

function getColumns({ agents }: { agents: GetAgentsResponses["200"] }) {
  const columns = getColumnsWithoutOrder({ agents });
  return Object.keys(columns).reduce(
    (acc, id) => {
      acc[id as ColumnId] = {
        ...columns[id as ColumnId],
        idx: Object.keys(acc).length,
      };
      return acc;
    },
    {} as Record<
      ColumnId,
      {
        label: string;
        render: (chat: GetChatsResponses["200"][number]) => React.ReactNode;
        onClick?: (chat: GetChatsResponses["200"][number]) => void;
        idx: number;
        cellClassName?: string;
      }
    >,
  );
}

const LOCAL_STORAGE_KEY = "archestra-selectedChatsColumns";
const ALWAYS_SELECTED_COLUMN_IDS = ["id", "actions"] as const;
const DEFAULT_SELECTED_COLUMNS: ColumnId[] = [
  ...ALWAYS_SELECTED_COLUMN_IDS,
  "interactions",
  "toolsUsed",
  "toolsRefused",
  "firstMessage",
  "createdAt",
];
function Chats({
  initialData,
}: {
  initialData?: {
    chats: GetChatsResponses["200"];
    agents: GetAgentsResponses["200"];
  };
}) {
  const { data: chats = [] } = useChats({ initialData: initialData?.chats });
  const { data: agents = [] } = useAgents({ initialData: initialData?.agents });
  const columns = getColumns({ agents: agents ?? [] });
  const [selectedColumns, setSelectedColumns] = useState<ColumnId[]>([]);

  const setColumns = useCallback((columns: ColumnId[]) => {
    const colsToSet = uniq([...ALWAYS_SELECTED_COLUMN_IDS, ...columns]);
    setSelectedColumns(colsToSet);
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(columns));
  }, []);

  useEffect(() => {
    // if user hasn't selected columns yet, we set some default
    const valueFromLocalStorage = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (valueFromLocalStorage == null) {
      setColumns(DEFAULT_SELECTED_COLUMNS);
    } else {
      // otherwise, we set columns from localStorage
      const cols = uniq([
        ...ALWAYS_SELECTED_COLUMN_IDS,
        ...(JSON.parse(valueFromLocalStorage) as ColumnId[]),
      ]);
      setColumns(cols);
    }
  }, [setColumns]);

  if (chats == null || chats.length === 0) {
    return <p className="text-muted-foreground">No chats found</p>;
  }
  return (
    <div className="w-full">
      <ColumnsSelector
        selectedColumnIds={selectedColumns}
        columns={columns}
        onSelect={setColumns}
        className="absolute top-0 right-6"
        alwaysSelectedColumnIds={ALWAYS_SELECTED_COLUMN_IDS}
      />
      <Table>
        <TableHeader>
          <TableRow>
            {selectedColumns.map((column) => (
              <TableHead
                className={cn("font-bold", columns[column].cellClassName)}
                key={column}
              >
                {columns[column].label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {chats.map((chat) => (
            <TableRow key={chat.id}>
              {selectedColumns
                .sort((a, b) => columns[a].idx - columns[b].idx)
                .map((column) => (
                  <TableCell
                    className={cn(
                      "break-words relative group",
                      columns[column].cellClassName,
                    )}
                    key={column}
                    {...(columns[column].onClick && {
                      onClick: () => columns[column].onClick?.(chat),
                    })}
                  >
                    {columns[column].render(chat)}
                  </TableCell>
                ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ColumnsSelector({
  selectedColumnIds,
  alwaysSelectedColumnIds = [],
  onSelect,
  className,
  columns,
}: {
  selectedColumnIds: ColumnId[];
  alwaysSelectedColumnIds?: readonly ColumnId[];
  onSelect: (columns: ColumnId[]) => void;
  className?: string;
  columns: ReturnType<typeof getColumns>;
}) {
  return (
    <div className={className}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">Select columns</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-56">
          {Object.keys(columns).map((id) => {
            const columnId = id as ColumnId;
            const column = columns[columnId];
            return (
              <DropdownMenuCheckboxItem
                key={columnId}
                className="cursor-pointer"
                checked={selectedColumnIds.includes(columnId)}
                disabled={alwaysSelectedColumnIds.includes(columnId)}
                onSelect={(e) => {
                  e.preventDefault();
                  if (alwaysSelectedColumnIds.includes(columnId)) {
                    return;
                  }
                  onSelect(
                    selectedColumnIds.includes(columnId)
                      ? selectedColumnIds.filter((id) => id !== columnId)
                      : [...selectedColumnIds, columnId],
                  );
                }}
              >
                {column.label}
              </DropdownMenuCheckboxItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function findFirstUserMessage(
  chat: GetChatsResponses["200"][number],
): string | undefined {
  const interaction = chat.interactions.find(
    (interaction) => interaction.content.role === "user",
  );
  if (typeof interaction?.content.content === "string") {
    return interaction.content.content;
  }
  if (interaction?.content.content?.[0]?.type === "text") {
    return interaction.content.content?.[0].text;
  }
  return undefined;
}

function findLastUserMessage(
  chat: GetChatsResponses["200"][number],
): string | undefined {
  const interaction = [...chat.interactions]
    .reverse()
    .find((interaction) => interaction.content.role === "user");
  if (typeof interaction?.content.content === "string") {
    return interaction.content.content;
  }
  if (interaction?.content.content?.[0]?.type === "text") {
    return interaction.content.content?.[0].text;
  }
  return undefined;
}
