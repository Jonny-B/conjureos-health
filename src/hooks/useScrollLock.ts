import { useEffect } from "react";

/**
 * Lock background scroll while a modal/sheet is open. On iOS a `position: fixed`
 * overlay does NOT stop the page (or the `.screen` scroll container) behind it
 * from rubber-band scrolling under touch — the sheet's own scroll area only
 * captures the gesture when it's actively scrollable, so drags "fall through" to
 * the background. Toggling `modal-open` on <html> lets CSS freeze the background
 * (`overflow: hidden`) for the duration; the fixed sheet keeps its own scroll.
 *
 * Ref-counted so overlapping/stacked sheets don't unlock early.
 */
let openCount = 0;

/** Freeze background scroll for as long as the calling component is mounted. */
export function useScrollLock(): void {
  useEffect(() => {
    openCount += 1;
    document.documentElement.classList.add("modal-open");
    return () => {
      openCount = Math.max(0, openCount - 1);
      if (openCount === 0) {
        document.documentElement.classList.remove("modal-open");
      }
    };
  }, []);
}
