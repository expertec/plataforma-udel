"use client";

import * as React from "react";

// simple classnames joiner
function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

type DialogProps = {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
};

export function Dialog({ open, onOpenChange, children }: DialogProps) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/40 px-4 py-8"
      onClick={() => onOpenChange?.(false)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[calc(100vw-2rem)] sm:max-w-6xl mx-auto"
      >
        {children}
      </div>
    </div>
  );
}

type DialogContentProps = React.HTMLAttributes<HTMLDivElement> & {
  children: React.ReactNode;
};

export function DialogContent({ children, className, ...rest }: DialogContentProps) {
  return (
    <div
      className={cn(
        "max-h-[calc(100vh-3rem)] overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl mx-auto",
        className
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function DialogHeader({ children }: { children: React.ReactNode }) {
  return <div className="mb-4">{children}</div>;
}

export function DialogTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-lg font-semibold text-slate-900">{children}</h2>;
}
