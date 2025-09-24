import { UIMessage } from 'ai';
import { useEffect, useRef, useState } from 'react';

export function useLastScrollDirection(ref: React.RefObject<HTMLDivElement | null>) {
  const [direction, setDirection] = useState<'up' | 'down' | null>(null);
  const lastScrollTop = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const handleScroll = () => {
      const currentTop = el.scrollTop;

      if (currentTop > lastScrollTop.current) {
        setDirection('down');
      } else if (currentTop < lastScrollTop.current) {
        setDirection('up');
      }

      lastScrollTop.current = currentTop;
    };

    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, [ref]);

  return direction;
}

export function useIsAtBottom(
  ref: React.RefObject<HTMLDivElement | null>,
  offset = 10 // tolerance in px
) {
  const [isAtBottom, setIsAtBottom] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      const atBottom = scrollHeight - scrollTop - clientHeight < offset;
      setIsAtBottom(atBottom);
    };

    el.addEventListener('scroll', handleScroll, { passive: true });
    // run once on mount
    handleScroll();

    return () => el.removeEventListener('scroll', handleScroll);
  }, [ref, offset]);

  return isAtBottom;
}

export function useChatScrolling({
  isSubmitting,
  messages,
  scrollAreaRef,
}: {
  isSubmitting?: boolean;
  messages: UIMessage[];
  scrollAreaRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [isAutoScrollingEnabled, setIsAutoScrollingEnabled] = useState(true);

  const scrollToBottom = () => {
    const el = scrollAreaRef.current;
    if (!el) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: 'smooth',
    });
  };

  const lastScrollDirection = useLastScrollDirection(scrollAreaRef);
  const isAtBottom = useIsAtBottom(scrollAreaRef, 300);

  useEffect(() => {
    if (lastScrollDirection === 'down') {
      setIsAutoScrollingEnabled(false);
    }
    if (isAtBottom) {
      setIsAutoScrollingEnabled(true);
    }
  }, [lastScrollDirection, isAtBottom]);

  // scrollToBottom on mount and every 700ms if at bottom
  useEffect(() => {
    let ticks = 0;

    const interval = setInterval(() => {
      ticks++;

      if (lastScrollDirection === 'down' && isAtBottom) {
        scrollToBottom();
      }

      // wait for 2 ticks to ensure first scroll is completed
      if (ticks > 2) {
        setShowScrollButton(!isAtBottom);
      }
    }, 200);

    return () => clearInterval(interval);
  }, [isAtBottom, lastScrollDirection]);

  useEffect(() => {
    if (isAutoScrollingEnabled) {
      scrollToBottom();
    }
  }, [isAutoScrollingEnabled, messages]);

  // additionally scroll when submitting
  useEffect(() => {
    if (isSubmitting) {
      scrollToBottom();
    }
  }, [isSubmitting]);

  return { showScrollButton, scrollToBottom };
}
