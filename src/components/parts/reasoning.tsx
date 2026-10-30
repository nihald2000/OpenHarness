import { useId, useState } from "react";
import { Brain, ChevronRight } from "lucide-react";

export function ReasoningView({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const contentId = useId();

  if (!text.trim() && !streaming) return null;

  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={contentId}
        className="touch-target inline-flex items-center gap-2 rounded-lg px-2 py-1 text-xs font-medium text-muted transition-colors duration-150 ease-out hover:bg-hover hover:text-fg"
      >
        <ChevronRight
          className={`size-3.5 transition-transform duration-150 ease-out ${
            open ? "rotate-90" : ""
          }`}
          aria-hidden="true"
        />
        <Brain
          className={`size-3.5 text-accent ${streaming ? "animate-pulse" : ""}`}
          aria-hidden="true"
        />
        <span>{streaming ? "Thinking" : "Thought process"}</span>
      </button>
      {open && (
        <div
          id={contentId}
          className="mt-2 ml-3 border-l-2 border-border pl-3 text-xs leading-normal text-muted whitespace-pre-wrap"
        >
          {text}
        </div>
      )}
    </div>
  );
}
