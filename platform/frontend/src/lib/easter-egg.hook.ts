"use client";

import { useEffect, useState } from "react";

export function useEasterEgg(targetSequence: string) {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [hasTriggered, setHasTriggered] = useState(false);

  useEffect(() => {
    // If already triggered or no target sequence, don't listen for more keystrokes
    if (hasTriggered || !targetSequence) {
      return;
    }

    let typedSequence = "";
    const timeoutDuration = 2000; // Reset sequence after 2 seconds of inactivity
    let timeout: NodeJS.Timeout;

    const handleKeyDown = (event: KeyboardEvent) => {
      // Only listen for actual letter keys, ignore special keys
      if (event.key.length !== 1) return;

      // Clear previous timeout
      clearTimeout(timeout);

      // Add the new character to sequence
      typedSequence += event.key.toLowerCase();

      // Keep only the last characters that could match our target
      if (typedSequence.length > targetSequence.length) {
        typedSequence = typedSequence.slice(-targetSequence.length);
      }

      // Check if we have a match
      if (typedSequence === targetSequence) {
        setIsDialogOpen(true);
        setHasTriggered(true);
        typedSequence = ""; // Reset sequence
        return;
      }

      // Set timeout to reset sequence
      timeout = setTimeout(() => {
        typedSequence = "";
      }, timeoutDuration);
    };

    // Add event listener
    document.addEventListener("keydown", handleKeyDown);

    // Cleanup
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      clearTimeout(timeout);
    };
  }, [targetSequence, hasTriggered]);

  const closeDialog = () => {
    setIsDialogOpen(false);
  };

  return {
    isDialogOpen,
    closeDialog,
    hasTriggered,
  };
}
