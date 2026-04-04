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
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30 backdrop-blur-[1px] animate-in fade-in duration-200">
      <div 
        className={cn(
          "bg-white w-full max-w-2xl h-full shadow-2xl border-l border-neutral-200 flex flex-col",
          "animate-in slide-in-from-right duration-300"
        )}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-100 bg-white z-10 shrink-0">
          <div>
            <h2 className="text-xl font-semibold text-neutral-900">{title}</h2>
            {description && <p className="text-sm text-neutral-500 mt-0.5">{description}</p>}
          </div>
          <button 
            onClick={onClose}
            className="text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 p-1.5 rounded-md transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        
        <div className="flex-1 overflow-y-auto bg-neutral-50 p-6 text-neutral-600">
          {children}
        </div>

        {footer && (
          <div className="px-6 py-4 border-t border-neutral-100 bg-white flex items-center justify-end gap-3 shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
