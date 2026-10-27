"use client";

import React, {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArrowUp, Square, TerminalSquare, Wrench, X } from "lucide-react";
import type { CommandInfo } from "@openharness/sdk";
import { Spinner } from "./ui";

export interface ComposerHandle {
  focus: () => void;
  setText: (text: string) => void;
  enableVerifyWith: (cmd: string) => void;
}

const VERIFY_STORAGE_KEY = "oh-verifyCommand";
let moduleVerifyEnabled = false;

export const Composer = forwardRef<
  ComposerHandle,
  {
    agentName: string;
    isPlanMode?: boolean;
    commands: CommandInfo[];
    active: boolean;
    sending: boolean;
    stopping: boolean;
    disabled?: boolean;
    onSend: (text: string, fix?: { commands: string[] }) => void;
    onStop: () => void;
  }
>(function Composer(
  {
    agentName,
    isPlanMode = false,
    commands,
    active,
    sending,
    stopping,
    disabled = false,
    onSend,
    onStop,
  },
  ref
) {
  const [text, setText] = useState("");
  const [verifyEnabled, setVerifyEnabled] = useState(moduleVerifyEnabled);
  const [verifyCommand, setVerifyCommand] = useState("bun test");
  const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const verifyInputRef = useRef<HTMLInputElement>(null);
  const slashListboxId = useId();

  useEffect(() => {
    try {
      const saved = localStorage.getItem(VERIFY_STORAGE_KEY);
      if (saved !== null) {
        setVerifyCommand(saved);
      }
    } catch {
      // ignore
    }
  }, []);

  const updateVerifyEnabled = (next: boolean) => {
    moduleVerifyEnabled = next;
    setVerifyEnabled(next);
  };

  const updateVerifyCommand = (val: string) => {
    setVerifyCommand(val);
    try {
      localStorage.setItem(VERIFY_STORAGE_KEY, val);
    } catch {
      // ignore
    }
  };

  useImperativeHandle(ref, () => ({
    focus: () => {
      textareaRef.current?.focus();
    },
    setText: (val: string) => {
      setText(val);
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    },
    enableVerifyWith: (cmd: string) => {
      updateVerifyEnabled(true);
      updateVerifyCommand(cmd);
    },
  }));

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(240, el.scrollHeight)}px`;
  }, [text]);

  const slashQuery = useMemo(() => {
    if (!text.startsWith("/")) return null;
    if (text.includes(" ") || text.includes("\n")) return null;
    return text.slice(1).toLowerCase();
  }, [text]);

  const matchingCommands = useMemo(() => {
    if (slashQuery === null || dismissedQuery === text) return [];
    const prefix: CommandInfo[] = [];
    const contains: CommandInfo[] = [];
    const sorted = [...commands].sort((a, b) => a.name.localeCompare(b.name));
    for (const cmd of sorted) {
      const lower = cmd.name.toLowerCase();
      if (lower.startsWith(slashQuery)) {
        prefix.push(cmd);
      } else if (lower.includes(slashQuery)) {
        contains.push(cmd);
      }
    }
    return [...prefix, ...contains].slice(0, 8);
  }, [commands, dismissedQuery, slashQuery, text]);

  const slashOpen = matchingCommands.length > 0;

  useEffect(() => {
    setSlashIndex(0);
  }, [slashQuery]);

  const pickCommand = (cmd: CommandInfo) => {
    const nextText = `/${cmd.name} `;
    setText(nextText);
    setDismissedQuery(null);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  };

  const trimmedCmd = verifyCommand.trim();
  const canSend =
    !disabled &&
    !active &&
    !sending &&
    text.trim().length > 0 &&
    (!verifyEnabled || trimmedCmd.length > 0);

  const submit = () => {
    if (!canSend) return;
    const payload = text.trim();
    const fix =
      verifyEnabled && trimmedCmd ? { commands: [trimmedCmd] } : undefined;
    setText("");
    onSend(payload, fix);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;

    if (slashOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % matchingCommands.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex(
          (i) => (i - 1 + matchingCommands.length) % matchingCommands.length
        );
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        const picked = matchingCommands[slashIndex];
        if (picked) {
          e.preventDefault();
          pickCommand(picked);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissedQuery(text);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const placeholder = isPlanMode
    ? "Describe what to plan..."
    : `Message ${agentName}... (/ for commands)`;

  const activeCmdId =
    slashOpen && matchingCommands[slashIndex]
      ? `${slashListboxId}-cmd-${slashIndex}`
      : undefined;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-3">
      <div className="relative">
        {slashOpen && (
          <div
            id={slashListboxId}
            role="listbox"
            aria-label="Slash commands"
            className="absolute bottom-full left-0 right-0 z-30 mb-2 max-h-64 overflow-y-auto rounded-xl border border-border bg-elev p-1.5 shadow-xl shadow-black/25 animate-fade-in"
          >
            {matchingCommands.map((cmd, idx) => {
              const isSelected = idx === slashIndex;
              return (
                <div
                  key={cmd.name}
                  id={`${slashListboxId}-cmd-${idx}`}
                  role="option"
                  aria-selected={isSelected}
                  onMouseEnter={() => setSlashIndex(idx)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickCommand(cmd);
                  }}
                  className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-xs ${
                    isSelected ? "bg-hover text-fg" : "text-fg hover:bg-hover/60"
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <TerminalSquare
                      className="size-3.5 shrink-0 text-accent"
                      aria-hidden="true"
                    />
                    <span className="font-mono font-medium">/{cmd.name}</span>
                    {cmd.description && (
                      <span className="truncate text-muted">
                        {cmd.description}
                      </span>
                    )}
                  </div>
                  {cmd.agent && (
                    <span className="shrink-0 font-mono text-[10px] text-muted">
                      {cmd.agent}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div
          className={`rounded-2xl border bg-elev p-2 transition-colors focus-within:border-accent ${
            verifyEnabled ? "border-warning/50" : "border-border"
          } ${disabled ? "opacity-40 pointer-events-none" : ""}`}
        >
          {verifyEnabled && (
            <div className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-subtle px-2.5 py-1.5 text-xs">
              <span className="font-medium text-fg">Verify &amp; fix with</span>
              <input
                ref={verifyInputRef}
                type="text"
                value={verifyCommand}
                onChange={(e) => updateVerifyCommand(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    textareaRef.current?.focus();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    updateVerifyEnabled(false);
                    textareaRef.current?.focus();
                  }
                }}
                placeholder="bun test"
                aria-label="Verify and fix command"
                className="min-w-[10rem] flex-1 rounded-md border border-border bg-bg px-2 py-1 font-mono text-xs text-fg placeholder:text-muted/70 focus-visible:border-accent"
              />
              {trimmedCmd ? (
                <span className="text-[11px] text-muted">
                  Runs after the turn; failures go back to the agent
                </span>
              ) : (
                <span className="text-[11px] font-medium text-warning">
                  Enter a command to enable
                </span>
              )}
              <button
                type="button"
                onClick={() => updateVerifyEnabled(false)}
                aria-label="Disable verify and fix"
                title="Disable verify and fix"
                className="rounded-md p-1 text-muted hover:bg-hover hover:text-fg"
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </div>
          )}

          <div className="flex items-end gap-2">
            <button
              type="button"
              onClick={() => {
                const next = !verifyEnabled;
                updateVerifyEnabled(next);
                if (next) {
                  requestAnimationFrame(() => verifyInputRef.current?.focus());
                }
              }}
              aria-label="Verify & fix toggle"
              title="Verify & fix toggle"
              aria-pressed={verifyEnabled}
              className={`relative inline-flex size-10 shrink-0 items-center justify-center rounded-xl border transition-colors ${
                verifyEnabled
                  ? "border-warning/40 bg-warning/10 text-warning"
                  : "border-transparent text-muted hover:bg-hover hover:text-fg"
              }`}
            >
              <Wrench className="size-4" aria-hidden="true" />
              {verifyEnabled && trimmedCmd && (
                <span
                  className="absolute top-1.5 right-1.5 size-2 rounded-full bg-warning"
                  aria-hidden="true"
                />
              )}
            </button>

            <textarea
              ref={textareaRef}
              id="oh-composer"
              rows={1}
              value={text}
              disabled={disabled}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={slashOpen}
              aria-controls={slashOpen ? slashListboxId : undefined}
              aria-activedescendant={activeCmdId}
              className="max-h-60 min-h-[2.5rem] flex-1 resize-none bg-transparent py-2 px-1 text-[14px] leading-6 text-fg placeholder:text-muted/70 focus:outline-none"
            />

            {active ? (
              <button
                type="button"
                onClick={onStop}
                disabled={stopping}
                aria-label="Stop"
                title="Stop"
                className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-danger/15 text-danger transition-colors hover:bg-danger/25 disabled:opacity-40"
              >
                {stopping ? (
                  <Spinner className="size-4" />
                ) : (
                  <Square
                    className="size-4 fill-current"
                    aria-hidden="true"
                  />
                )}
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={!canSend}
                aria-label="Send message"
                title="Send message"
                className={`inline-flex size-10 shrink-0 items-center justify-center rounded-xl transition-colors ${
                  canSend
                    ? "bg-accent text-accent-fg hover:bg-accent-strong"
                    : "bg-subtle text-muted opacity-50 pointer-events-none"
                }`}
              >
                {sending ? (
                  <Spinner className="size-4" />
                ) : (
                  <ArrowUp className="size-4" aria-hidden="true" />
                )}
              </button>
            )}
          </div>
        </div>

        <div className="mt-1.5 hidden md:flex items-center justify-between px-1 text-[11px] text-muted">
          <span>
            Enter to send · Shift+Enter for a new line · / for commands
            {verifyEnabled && trimmedCmd
              ? ` · will verify with ${trimmedCmd}`
              : ""}
          </span>
          {isPlanMode && <span>plan mode is read-only</span>}
        </div>
      </div>
    </div>
  );
});
