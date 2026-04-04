"use client";

import { EmojiPicker } from "@ferrucc-io/emoji-picker";
import {
  Bot,
  ImageIcon,
  Layers,
  Network,
  Route,
  Server,
  SmileIcon,
  Upload,
  X,
} from "lucide-react";
import Image from "next/image";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import type { AgentIconVariant } from "@/components/agent-icon";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { ServiceLogoPicker } from "./service-logo-picker";

const MAX_IMAGE_SIZE = 512 * 1024; // 512 KB

interface AgentIconPickerProps {
  value: string | null;
  onChange: (icon: string | null) => void;
  className?: string;
  /** Show a "Logos" tab with pre-built service brand logos */
  showLogos?: boolean;
  fallbackType?: AgentIconVariant | "server";
}

export function AgentIconPicker({
  value,
  onChange,
  className,
  showLogos = false,
  fallbackType = "agent",
}: AgentIconPickerProps) {
  const [open, setOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isImage = value?.startsWith("data:");

  const handleEmojiSelect = useCallback(
    (emoji: string) => {
      onChange(emoji);
      setOpen(false);
    },
    [onChange],
  );

  const handleLogoSelect = useCallback(
    (dataUrl: string) => {
      onChange(dataUrl);
      setOpen(false);
    },
    [onChange],
  );

  const handleFileUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      if (!file.type.startsWith("image/")) {
        toast.error("Please upload an image file");
        return;
      }

      if (file.size > MAX_IMAGE_SIZE) {
        toast.error("Image must be smaller than 512 KB");
        return;
      }

      const reader = new FileReader();
      reader.onload = (event) => {
        const base64 = event.target?.result as string;
        onChange(base64);
        setOpen(false);
      };
      reader.readAsDataURL(file);

      // Reset input so same file can be selected again
      e.target.value = "";
    },
    [onChange],
  );

  const handleRemove = useCallback(
    (e: React.MouseEvent | React.KeyboardEvent) => {
      e.stopPropagation();
      onChange(null);
    },
    [onChange],
  );

  const defaultTab = showLogos ? "logos" : "emoji";
  const FallbackIcon =
    fallbackType === "llm_proxy"
      ? Network
      : fallbackType === "mcp_gateway"
        ? Route
        : fallbackType === "server"
          ? Server
          : Bot;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "relative group flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border-2 border-dashed hover:border-primary/50 hover:bg-accent transition-colors cursor-pointer",
            value && "border-solid border-border",
            className,
          )}
        >
          {value ? (
            isImage ? (
              <Image
                src={value}
                alt="Agent icon"
                width={32}
                height={32}
                className="rounded-md object-contain"
              />
            ) : (
              <span className="text-2xl leading-none">{value}</span>
            )
          ) : (
            <FallbackIcon className="h-5 w-5 text-muted-foreground" />
          )}
          {value && (
            // biome-ignore lint/a11y/useSemanticElements: can't use <button> here as it's nested inside PopoverTrigger's <button>
            <div
              role="button"
              tabIndex={0}
              onClick={handleRemove}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") handleRemove(e);
              }}
              className="absolute -top-1.5 -right-1.5 hidden group-hover:flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-destructive-foreground cursor-pointer"
            >
              <X className="h-2.5 w-2.5" />
            </div>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[352px] p-0" align="start" sideOffset={8}>
        <Tabs defaultValue={defaultTab}>
          <TabsList className="w-full rounded-none border-b bg-transparent p-0 h-auto">
            {showLogos && (
              <TabsTrigger
                value="logos"
                className="flex-1 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:shadow-none gap-1.5 py-2.5"
              >
                <Layers className="h-3.5 w-3.5" />
                Logos
              </TabsTrigger>
            )}
            <TabsTrigger
              value="emoji"
              className="flex-1 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:shadow-none gap-1.5 py-2.5"
            >
              <SmileIcon className="h-3.5 w-3.5" />
              Emoji
            </TabsTrigger>
            <TabsTrigger
              value="upload"
              className="flex-1 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:shadow-none gap-1.5 py-2.5"
            >
              <ImageIcon className="h-3.5 w-3.5" />
              Upload
            </TabsTrigger>
          </TabsList>
          {showLogos && (
            <TabsContent
              value="logos"
              className="m-0"
              onWheel={(e) => e.stopPropagation()}
              onTouchMove={(e) => e.stopPropagation()}
            >
              <ServiceLogoPicker onSelect={handleLogoSelect} />
            </TabsContent>
          )}
          <TabsContent
            value="emoji"
            className="m-0"
            onWheel={(e) => e.stopPropagation()}
            onTouchMove={(e) => e.stopPropagation()}
          >
            <EmojiPicker
              onEmojiSelect={handleEmojiSelect}
              emojisPerRow={8}
              emojiSize={32}
            >
              <EmojiPicker.Header>
                <EmojiPicker.Input placeholder="Search emoji..." />
              </EmojiPicker.Header>
              <EmojiPicker.Group>
                <EmojiPicker.List containerHeight={280} />
              </EmojiPicker.Group>
            </EmojiPicker>
          </TabsContent>
          <TabsContent value="upload" className="m-0 p-4">
            <div className="flex flex-col items-center gap-3 py-6">
              <div className="flex h-16 w-16 items-center justify-center rounded-lg border-2 border-dashed">
                {value && isImage ? (
                  <Image
                    src={value}
                    alt="Preview"
                    width={48}
                    height={48}
                    className="rounded-md object-contain"
                  />
                ) : (
                  <Upload className="h-6 w-6 text-muted-foreground" />
                )}
              </div>
              <p className="text-sm text-muted-foreground text-center">
                PNG, JPG, SVG or GIF. Max 512 KB.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
              >
                Choose image
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleFileUpload}
              />
            </div>
          </TabsContent>
        </Tabs>
      </PopoverContent>
    </Popover>
  );
}
