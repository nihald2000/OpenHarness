import React from "react";
import { BookOpen } from "lucide-react";
import type { SkillPart } from "@openharness/sdk";

export function SkillChip({ part }: { part: SkillPart }) {
  const title =
    part.reason === "trigger"
      ? "Loaded automatically by a keyword trigger"
      : "Loaded by the agent";
  return (
    <div
      title={title}
      className="inline-flex items-center gap-2 rounded-full border border-accent/25 bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent"
    >
      <BookOpen className="size-3" aria-hidden="true" />
      <span>skill loaded: {part.name}</span>
    </div>
  );
}
