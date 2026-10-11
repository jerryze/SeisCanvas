import { useEffect, useRef, type RefObject } from "react";

/** Keep keyboard navigation inside the top modal and restore its opener. */
export function useModalFocus(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void, canClose = true) {
  const latest = useRef({ onClose, canClose });
  latest.current = { onClose, canClose };
  useEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    const controls = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), iframe, [tabindex]:not([tabindex="-1"])',
    )).filter(el => el.tabIndex >= 0 && el.getClientRects().length);
    (controls()[0] || dialog).focus();
    const keydown = (event: KeyboardEvent) => {
      const modals = Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"]')).filter(el => el.getClientRects().length);
      if (modals.at(-1) !== dialog || event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (latest.current.canClose) latest.current.onClose();
      }
      if (event.key === "Tab") {
        const elements = controls();
        const first = elements[0] || dialog;
        const last = elements.at(-1) || dialog;
        if (!dialog.contains(document.activeElement) || !elements.length || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      if (previous?.isConnected) previous.focus();
    };
  }, [open, ref]);
}
