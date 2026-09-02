"use client";

import { useCallback, useEffect, useId, useRef, type ReactNode } from "react";

/**
 * The one modal shell every Plus screen sits in: a bottom sheet on a phone, a
 * centered card from `sm` up. Escape closes it, the backdrop closes it, focus
 * moves in on open and back to the opener on close, and Tab cycles inside — so
 * it is usable without a mouse and does not strand a screen reader behind it.
 *
 * Deliberately no `overflow-hidden`: the sheet scrolls its own content, and a
 * clipped rounded container is exactly the failure e2e/layout.spec.ts hunts for.
 */
export function Sheet({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Pinned under the scrolling body — the primary action lives here. */
  footer?: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<Element | null>(null);
  const titleId = useId();

  const focusables = useCallback((): HTMLElement[] => {
    const root = panelRef.current;
    if (!root) return [];
    return Array.from(
      root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.offsetParent !== null || el === document.activeElement);
  }, []);

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement;
    const first = focusables()[0] ?? panelRef.current;
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (!items.length) return;
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === firstEl || !panelRef.current?.contains(active))) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && active === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    // Stop the page behind the sheet scrolling with it.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      const opener = openerRef.current;
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, [open, onClose, focusables]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-slate-900/50 backdrop-blur-[2px]"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative flex max-h-[92vh] w-full max-w-md flex-col rounded-t-3xl bg-white shadow-2xl ring-1 ring-slate-900/10 dark:bg-slate-900 dark:ring-white/10 sm:rounded-3xl"
      >
        <div className="flex items-start justify-between gap-3 px-5 pb-2 pt-5">
          <h2
            id={titleId}
            className="text-lg font-bold text-slate-900 dark:text-white"
          >
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 -mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-900/5 dark:hover:bg-white/10"
          >
            <span aria-hidden className="text-lg leading-none">
              ✕
            </span>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">{children}</div>
        {footer ? (
          <div className="border-t border-slate-900/10 px-5 py-4 dark:border-white/10">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}

/** The shared look of a choice chip (onboarding questions, settings rows). */
export function Chip({
  selected,
  onClick,
  children,
  disabled = false,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={`inline-flex min-h-[44px] items-center justify-center rounded-full px-4 py-2 text-sm font-medium ring-1 transition disabled:opacity-50 ${
        selected
          ? "bg-ocean-500/20 text-ocean-800 ring-ocean-500/40 dark:text-ocean-200"
          : "bg-slate-900/5 text-slate-700 ring-slate-900/10 hover:bg-slate-900/10 dark:bg-white/5 dark:text-slate-200 dark:ring-white/10 dark:hover:bg-white/10"
      }`}
    >
      {children}
    </button>
  );
}

/** The one full-width call to action a screen is allowed. */
export function PrimaryButton({
  onClick,
  children,
  disabled = false,
  type = "button",
}: {
  onClick?: () => void;
  children: ReactNode;
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="flex min-h-[48px] w-full items-center justify-center rounded-full bg-ocean-600 px-5 py-3 text-base font-semibold text-white transition hover:bg-ocean-700 disabled:opacity-60"
    >
      {children}
    </button>
  );
}

/** A quieter second action under the primary one. */
export function SecondaryButton({
  onClick,
  children,
  disabled = false,
}: {
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex min-h-[44px] w-full items-center justify-center rounded-full px-5 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-900/5 disabled:opacity-60 dark:text-slate-300 dark:hover:bg-white/10"
    >
      {children}
    </button>
  );
}

/** One short line of trouble, in plain English. */
export function ErrorLine({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="mt-2 text-sm leading-snug text-rose-600 dark:text-rose-400">
      {message}
    </p>
  );
}
