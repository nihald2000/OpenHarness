import React, {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArrowUp, FileText, FolderUp, Plus, Square, TerminalSquare, Wrench, X } from "lucide-react";
import type { CommandInfo } from "@openharness/sdk";
import { Spinner } from "./ui";

export interface ComposerHandle {
  focus: () => void;
  setText: (text: string) => void;
  restoreAttachments: (files: SelectedAttachment[]) => void;
}

export interface SelectedAttachment {
  file: File;
  relativePath: string;
  groupId: string;
}

const MAX_FILES = 100;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const formatBytes = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

const newGroupId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `files_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

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
    uploadProgress?: { completed: number; total: number } | null;
    disabled?: boolean;
    onSend: (text: string, fix?: { commands: string[] }, files?: SelectedAttachment[]) => void;
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
    uploadProgress = null,
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
  const [attachments, setAttachments] = useState<SelectedAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
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

  useEffect(() => {
    folderInputRef.current?.setAttribute("webkitdirectory", "");
    folderInputRef.current?.setAttribute("directory", "");
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
    restoreAttachments: (files: SelectedAttachment[]) => {
      setAttachments((current) => [...files, ...current]);
    },
  }));

  const addFiles = (fileList: FileList | File[]) => {
    const picked = Array.from(fileList);
    const groupId = newGroupId();
    const additions = picked.map((file) => ({
      file,
      relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
      groupId,
    }));
    setAttachmentError("");
    const next = [...attachments, ...additions];
    const totalBytes = next.reduce((sum, item) => sum + item.file.size, 0);
    if (next.length > MAX_FILES) {
      setAttachmentError(`Attach up to ${MAX_FILES} files at a time.`);
      return;
    }
    if (totalBytes > MAX_TOTAL_BYTES) {
      setAttachmentError("Attachments must total 20 MB or less.");
      return;
    }
    setAttachments(next);
    setAttachMenuOpen(false);
    textareaRef.current?.focus();
  };

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
    (text.trim().length > 0 || attachments.length > 0) &&
    (!verifyEnabled || trimmedCmd.length > 0);

  const submit = () => {
    if (!canSend) return;
    const payload = text.trim();
    const files = attachments;
    const fix =
      verifyEnabled && trimmedCmd ? { commands: [trimmedCmd] } : undefined;
    setText("");
    setAttachments([]);
    setAttachmentError("");
    onSend(payload, fix, files);
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
    <div
      className="mx-auto w-full max-w-[720px] px-4 pb-4"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files.length) {
          e.preventDefault();
          addFiles(e.dataTransfer.files);
        }
      }}
    >
      <div className="relative">
        {attachMenuOpen && (
          <div role="menu" aria-label="Add attachments" className="absolute bottom-full left-0 z-30 mb-2 w-52 rounded-xl border border-border bg-bg p-1 shadow-menu animate-fade-in">
            <button type="button" role="menuitem" onClick={() => fileInputRef.current?.click()} className="touch-target flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-fg hover:bg-hover">
              <FileText className="size-4 text-accent" aria-hidden="true" /> Add files
            </button>
            <button type="button" role="menuitem" onClick={() => folderInputRef.current?.click()} className="touch-target flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-fg hover:bg-hover">
              <FolderUp className="size-4 text-accent" aria-hidden="true" /> Add folder
            </button>
            <p className="px-3 pb-2 pt-1 text-[11px] text-muted">Up to 100 files, 20 MB total. Code mode can work with any file type.</p>
          </div>
        )}
        <input ref={fileInputRef} type="file" multiple className="sr-only" onChange={(e) => { if (e.currentTarget.files) addFiles(e.currentTarget.files); e.currentTarget.value = ""; }} />
        <input ref={folderInputRef} type="file" multiple className="sr-only" onChange={(e) => { if (e.currentTarget.files) addFiles(e.currentTarget.files); e.currentTarget.value = ""; }} />
        {slashOpen && (
          <div
            id={slashListboxId}
            role="listbox"
            aria-label="Slash commands"
            className="absolute bottom-full left-0 right-0 z-30 mb-2 max-h-64 overflow-y-auto rounded-xl border border-border bg-bg p-1 shadow-menu animate-fade-in"
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
                  className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 text-xs transition-colors duration-150 ease-out ${
                    isSelected ? "bg-hover text-fg" : "text-fg hover:bg-hover/70"
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
                    <span className="shrink-0 font-mono text-xs text-muted">
                      {cmd.agent}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div
          className={`rounded-2xl border border-border bg-elev p-2 shadow-card transition-colors duration-150 ease-out focus-within:border-accent focus-within:bg-bg ${
            disabled ? "opacity-40 pointer-events-none" : ""
          }`}
        >
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2 border-b border-border px-1 pb-2">
              {attachments.map((item, index) => (
                <div key={`${item.groupId}:${item.relativePath}:${index}`} title={item.relativePath} className="flex max-w-full items-center gap-2 rounded-xl border border-border bg-bg px-2 py-1.5 text-xs">
                  <FileText className="size-3.5 shrink-0 text-accent" aria-hidden="true" />
                  <span className="max-w-44 truncate text-fg">{item.relativePath}</span>
                  <span className="shrink-0 text-muted">{formatBytes(item.file.size)}</span>
                  <button type="button" onClick={() => setAttachments((current) => current.filter((_, i) => i !== index))} aria-label={`Remove ${item.file.name}`} className="touch-target inline-flex size-5 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg">
                    <X className="size-3" aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {verifyEnabled && (
            <div className="mb-2 flex flex-wrap items-center gap-2 border-b border-border px-2 pb-2 text-xs">
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
                className="h-7 min-w-[10rem] flex-1 rounded-lg border border-border bg-bg px-2 font-mono text-xs text-fg placeholder:text-muted focus-visible:border-accent"
              />
              {trimmedCmd ? (
                <span className="text-xs text-muted">
                  Runs after the turn; failures go back to the agent
                </span>
              ) : (
                <span className="text-xs font-medium text-warning">
                  Enter a command to enable
                </span>
              )}
              <button
                type="button"
                onClick={() => updateVerifyEnabled(false)}
                aria-label="Disable verify and fix"
                title="Disable verify and fix"
                className="touch-target inline-flex size-6 items-center justify-center rounded-lg text-muted transition-colors duration-150 ease-out hover:bg-hover hover:text-fg"
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </div>
          )}

          <div className="flex items-end gap-2">
            <button
              type="button"
              onClick={() => setAttachMenuOpen((open) => !open)}
              aria-label="Add files or folder"
              title="Add files or folder"
              aria-expanded={attachMenuOpen}
              className="touch-target inline-flex size-9 shrink-0 items-center justify-center rounded-xl text-muted transition-colors duration-150 ease-out hover:bg-hover hover:text-fg"
            >
              <Plus className={`size-5 transition-transform ${attachMenuOpen ? "rotate-45" : ""}`} aria-hidden="true" />
            </button>
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
              className={`touch-target relative inline-flex size-9 shrink-0 items-center justify-center rounded-xl border transition-colors duration-150 ease-out ${
                verifyEnabled
                  ? "border-accent/30 bg-accent/10 text-accent"
                  : "border-transparent text-muted hover:bg-hover hover:text-fg"
              }`}
            >
              <Wrench className="size-4" aria-hidden="true" />
              {verifyEnabled && trimmedCmd && (
                <span
                  className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-accent"
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
              className="max-h-60 min-h-[2.25rem] flex-1 resize-none bg-transparent py-2 px-1 text-sm leading-normal text-fg placeholder:text-muted focus:outline-none"
            />

            {active ? (
              <button
                type="button"
                onClick={onStop}
                disabled={stopping}
                aria-label="Stop"
                title="Stop"
                className="touch-target inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-danger/15 text-danger transition-colors duration-150 ease-out hover:bg-danger/25 disabled:opacity-40"
              >
                {stopping ? (
                  <Spinner className="size-4" />
                ) : (
                  <Square
                    className="size-3.5 fill-current"
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
                className={`touch-target inline-flex size-9 shrink-0 items-center justify-center rounded-xl transition-colors duration-150 ease-out ${
                  canSend
                    ? "bg-accent text-accent-fg hover:bg-accent-strong"
                    : "bg-hover text-muted opacity-50 pointer-events-none"
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

        {attachmentError && <p role="alert" className="mt-2 px-1 text-xs text-danger">{attachmentError}</p>}

        {uploadProgress && (
          <div className="mt-2 px-1 text-xs text-muted" role="status" aria-live="polite">
            Uploading files {uploadProgress.completed}/{uploadProgress.total}…
          </div>
        )}
        <div className="mt-2 hidden md:flex items-center justify-between px-1 text-xs text-muted">
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
