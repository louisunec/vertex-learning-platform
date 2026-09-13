"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

/**
 * Bottom drawer for small screens, on the native modal `<dialog>`: the
 * browser traps focus, closes on Escape, and returns focus to the element
 * that opened it. Clicking the backdrop closes it too. The lesson video sits
 * outside the dialog, so opening or closing never remounts the player.
 */
export function Drawer({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="ph-no-capture fixed inset-x-0 top-auto bottom-0 m-0 max-h-[85dvh] w-full max-w-none flex-col rounded-t-[20px] border-t border-neutral-200 bg-surface p-0 text-neutral-900 shadow-lg backdrop:bg-black/60 open:flex"
    >
      <div className="flex items-center justify-between gap-4 border-b border-neutral-200 px-5 py-4">
        <h2 id={titleId} className="font-display text-h3 text-neutral-900">
          {title}
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-2 py-1 text-body text-neutral-500 hover:text-neutral-900 focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:outline-none"
        >
          Close
        </button>
      </div>
      <div className="overflow-y-auto px-5 pt-4 pb-8">{children}</div>
    </dialog>
  );
}
