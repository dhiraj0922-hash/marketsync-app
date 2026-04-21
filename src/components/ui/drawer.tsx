import * as React from "react"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"

interface DrawerProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}

export function Drawer({ isOpen, onClose, title, description, children, footer }: DrawerProps) {
  if (!isOpen) return null;

  return (
    // Backdrop: full-viewport overlay. Clicking it closes the drawer.
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/30 backdrop-blur-[1px] animate-in fade-in duration-200"
      onClick={onClose}
    >
      {/* Panel: stop click propagation so interactions inside never hit the backdrop */}
      <div
        className={cn(
          "bg-white w-full sm:max-w-xl lg:max-w-2xl h-full shadow-2xl border-l border-neutral-200 flex flex-col",
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
    </div>
  );
}
