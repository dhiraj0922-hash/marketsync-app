import * as React from "react"
import { createPortal } from "react-dom"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"

interface DrawerProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** 'panel' (default) = full-height right side-panel. 'dialog' = centered modal, max-h-[85vh], internally scrollable. */
  variant?: 'panel' | 'dialog';
}

export function Drawer({ isOpen, onClose, title, description, children, footer, variant = 'panel' }: DrawerProps) {
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  React.useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen || !mounted || typeof document === "undefined") return null;

  if (variant === 'dialog') {
    return createPortal(
      // Dialog backdrop — centered, max-height constrained
      <div
        className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-black/50 backdrop-blur-[2px] animate-in fade-in duration-200 p-4"
        onClick={onClose}
      >
        <div
          className={cn(
            "relative flex w-full max-w-[1100px] flex-col overflow-hidden rounded-xl bg-white shadow-2xl",
            "border border-neutral-200",
            "max-h-[85vh]",
            "animate-in zoom-in-95 duration-200"
          )}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Sticky header */}
          <div className="flex items-center justify-between px-4 sm:px-5 py-3 border-b border-neutral-100 bg-white z-10 shrink-0">
            <div className="min-w-0 flex-1 pr-2">
              <h2 className="text-base sm:text-lg font-semibold text-neutral-900 truncate">{title}</h2>
              {description && <p className="text-xs text-neutral-500 mt-0.5 truncate">{description}</p>}
            </div>
            <button
              onClick={onClose}
              className="text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 p-1.5 rounded-md transition-colors shrink-0"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Scrollable body */}
          <div className="flex-1 overflow-y-auto bg-neutral-50 p-3 sm:p-4 text-neutral-600 min-h-0">
            {children}
          </div>

          {/* Sticky footer */}
          {footer && (
            <div className="px-4 sm:px-5 py-3 border-t border-neutral-100 bg-white shrink-0 w-full">
              {footer}
            </div>
          )}
        </div>
      </div>,
      document.body
    );
  }

  return createPortal(
    // Backdrop: full-viewport overlay. Clicking it closes the drawer.
    <div
      className="fixed inset-0 z-[100] flex justify-end overflow-y-auto bg-black/40 backdrop-blur-[1px] animate-in fade-in duration-200"
      onClick={onClose}
    >
      {/* Panel: stop click propagation so interactions inside never hit the backdrop */}
      <div
        className={cn(
          "ml-auto flex h-[100dvh] max-h-[100dvh] w-full flex-col overflow-hidden bg-white shadow-2xl sm:max-w-xl lg:max-w-2xl",
          "border-l border-neutral-200",
          "animate-in slide-in-from-right duration-300"
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-4 border-b border-neutral-100 bg-white z-10 shrink-0">
          <div className="min-w-0 flex-1 pr-2">
            <h2 className="text-lg sm:text-xl font-semibold text-neutral-900 truncate">{title}</h2>
            {description && <p className="text-xs sm:text-sm text-neutral-500 mt-0.5 truncate">{description}</p>}
          </div>
          <button
            onClick={onClose}
            className="text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 p-1.5 rounded-md transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto bg-neutral-50 p-4 sm:p-6 text-neutral-600">
          {children}
        </div>

        {footer && (
          // IMPORTANT: do NOT add justify-end or gap here.
          // Callers own the footer layout (e.g. justify-between for left + right button groups).
          // The only container responsibility is: full width, padding, border, background.
          <div className="px-4 sm:px-6 py-3 sm:py-4 border-t border-neutral-100 bg-white shrink-0 w-full">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
