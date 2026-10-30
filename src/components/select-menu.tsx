import React, { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

export interface SelectOption {
  id: string;
  label: string;
  description?: string;
  meta?: string;
  color?: string;
  badge?: string;
  icon?: React.ReactNode;
}

export function SelectMenu({
  label,
  value,
  options,
  onChange,
  icon,
  badge,
  disabled,
  disabledTitle,
  buttonClassName = "",
  align = "right",
}: {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (id: string) => void;
  icon?: React.ReactNode;
  badge?: string;
  disabled?: boolean;
  disabledTitle?: string;
  buttonClassName?: string;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const selected = options.find((o) => o.id === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const idx = Math.max(
      0,
      options.findIndex((o) => o.id === value)
    );
    setActiveIndex(idx);
    requestAnimationFrame(() => {
      listRef.current?.focus();
    });
  }, [open, options, value]);

  useEffect(() => {
    if (!open) return;
    const optEl = listRef.current?.querySelector<HTMLElement>(
      `[data-opt-index="${activeIndex}"]`
    );
    optEl?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [open]);

  const selectOption = (opt: SelectOption) => {
    onChange(opt.id);
    setOpen(false);
    buttonRef.current?.focus();
  };

  const handleButtonKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
    }
  };

  const handleListKeyDown = (e: React.KeyboardEvent) => {
    if (options.length === 0) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((prev) => (prev + 1) % options.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((prev) => (prev - 1 + options.length) % options.length);
        break;
      case "Home":
        e.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        e.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case "Enter":
      case " ": {
        e.preventDefault();
        const opt = options[activeIndex];
        if (opt) selectOption(opt);
        break;
      }
      case "Escape":
      case "Tab":
        e.preventDefault();
        setOpen(false);
        buttonRef.current?.focus();
        break;
      default:
        break;
    }
  };

  const activeOption = options[activeIndex];
  const activeOptionId = activeOption
    ? `${listboxId}-opt-${activeIndex}`
    : undefined;

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={handleButtonKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${selected?.label ?? value}`}
        title={disabled && disabledTitle ? disabledTitle : `${label}: ${selected?.label ?? value}`}
        className={`inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-elev px-2.5 text-xs font-medium text-fg transition-colors hover:bg-hover disabled:pointer-events-none disabled:opacity-40 ${buttonClassName}`}
      >
        {selected?.color ? (
          <span
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: selected.color }}
            aria-hidden="true"
          />
        ) : (
          icon
        )}
        <span className="max-w-[9rem] truncate">
          {selected?.label ?? value}
        </span>
        {badge && (
          <span className="rounded-full border border-accent/40 bg-accent/10 px-1.5 py-0.2 text-[10px] font-medium text-accent">
            {badge}
          </span>
        )}
        <ChevronDown className="size-3.5 text-muted" aria-hidden="true" />
      </button>

      {open && (
        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          tabIndex={-1}
          aria-label={label}
          aria-activedescendant={activeOptionId}
          onKeyDown={handleListKeyDown}
          className={`absolute top-full z-40 mt-1.5 max-h-80 w-72 overflow-y-auto rounded-xl border border-border bg-elev p-1.5 shadow-xl shadow-black/25 animate-fade-in ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {options.map((opt, idx) => {
            const isSelected = opt.id === value;
            const isActive = idx === activeIndex;
            return (
              <div
                key={opt.id}
                id={`${listboxId}-opt-${idx}`}
                data-opt-index={idx}
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => selectOption(opt)}
                className={`flex cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2 text-xs transition-colors ${
                  isActive ? "bg-hover text-fg" : "text-fg hover:bg-hover/60"
                }`}
              >
                <div className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
                  {opt.color ? (
                    <span
                      className="size-2.5 rounded-full"
                      style={{ backgroundColor: opt.color }}
                      aria-hidden="true"
                    />
                  ) : (
                    opt.icon
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium truncate">{opt.label}</span>
                    {opt.badge && (
                      <span className="rounded-full border border-accent/40 bg-accent/10 px-1.5 py-0.2 text-[10px] font-medium text-accent">
                        {opt.badge}
                      </span>
                    )}
                  </div>
                  {opt.description && (
                    <p className="mt-0.5 text-[11px] text-muted line-clamp-2">
                      {opt.description}
                    </p>
                  )}
                  {opt.meta && (
                    <p className="mt-0.5 font-mono text-[10px] text-muted">
                      {opt.meta}
                    </p>
                  )}
                </div>
                {isSelected && (
                  <Check
                    className="mt-0.5 size-3.5 shrink-0 text-accent"
                    aria-hidden="true"
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
