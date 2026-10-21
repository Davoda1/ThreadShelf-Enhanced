import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';

// Lists are portaled outside scrollable panels. Fit them to the visible viewport
// and choose the side of the input with more room (including mobile keyboards).
export function useListboxPosition(
  anchor: RefObject<HTMLElement | null>,
  open: boolean,
  heightLimit: number,
): CSSProperties {
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' });

  useLayoutEffect(() => {
    if (!open) return undefined;
    const update = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const viewport = window.visualViewport;
      const left = (viewport?.offsetLeft ?? 0) + 8;
      const top = (viewport?.offsetTop ?? 0) + 8;
      const right = left + (viewport?.width ?? window.innerWidth) - 16;
      const bottom = top + (viewport?.height ?? window.innerHeight) - 16;
      const below = Math.max(0, bottom - rect.bottom - 5);
      const above = Math.max(0, rect.top - top - 5);
      const down = below >= Math.min(heightLimit, above);
      const width = Math.min(rect.width, Math.max(0, right - left));
      setPosition({
        position: 'fixed',
        zIndex: 120,
        left: Math.max(left, Math.min(rect.left, right - width)),
        right: 'auto',
        width,
        top: down ? Math.max(top, rect.bottom + 5) : 'auto',
        bottom: down
          ? 'auto'
          : Math.max(window.innerHeight - bottom, window.innerHeight - rect.top + 5),
        maxHeight: Math.min(heightLimit, down ? below : above),
        visibility: rect.bottom > top && rect.top < bottom ? 'visible' : 'hidden',
      });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    const observer = new ResizeObserver(update);
    if (anchor.current) observer.observe(anchor.current);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, [anchor, open, heightLimit]);

  return position;
}
