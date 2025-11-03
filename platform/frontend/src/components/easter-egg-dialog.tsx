"use client";

import { Dialog, DialogContent } from "@/components/ui/dialog";

interface EasterEggDialogProps {
  open: boolean;
  videoUrl: string;
  onOpenChange: (open: boolean) => void;
}

export function EasterEggDialog({
  open,
  videoUrl,
  onOpenChange,
}: EasterEggDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-4xl w-full h-[80vh] p-0 overflow-hidden"
        showCloseButton={true}
      >
        <div className="w-full h-full">
          <iframe
            width="100%"
            height="100%"
            src={videoUrl}
            title="Easter Egg"
            frameBorder="0"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
            className="w-full h-full"
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
