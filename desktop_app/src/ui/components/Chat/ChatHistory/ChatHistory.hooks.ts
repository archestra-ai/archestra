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
