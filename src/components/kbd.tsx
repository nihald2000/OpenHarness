import React from "react";

export function Kbd({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <kbd
      className={`inline-flex items-center justify-center rounded border border-border bg-subtle px-1.5 py-0.5 font-mono text-[10px] font-medium leading-none text-muted ${className}`}
    >
      {children}
    </kbd>
  );
}
