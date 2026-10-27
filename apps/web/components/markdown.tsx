"use client";

import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CopyButton } from "./copy-button";

export function Markdown({
  children,
  streaming = false,
  className = "",
}: {
  children: string;
  streaming?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`markdown text-[15px] leading-relaxed ${
        streaming ? "streaming-caret" : ""
      } ${className}`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          pre({ children: preChildren }) {
            let lang = "Text";
            let codeText = "";
            React.Children.forEach(preChildren, (child) => {
              if (React.isValidElement(child)) {
                const props = child.props as {
                  className?: string;
                  children?: React.ReactNode;
                };
                const match = /language-([\w-]+)/.exec(props.className || "");
                if (match && match[1]) {
                  lang = match[1];
                }
                if (typeof props.children === "string") {
                  codeText = props.children.replace(/\n$/, "");
                } else if (Array.isArray(props.children)) {
                  codeText = props.children.join("").replace(/\n$/, "");
                }
              }
            });

            return (
              <div className="my-2.5 overflow-hidden rounded-xl border border-border bg-code">
                <div className="flex items-center justify-between border-b border-border bg-subtle/60 px-3 py-1.5 text-[11px] font-mono text-muted">
                  <span>{lang}</span>
                  <CopyButton text={codeText} label="Copy code" />
                </div>
                <pre className="overflow-x-auto p-3 font-mono text-[13px] leading-relaxed text-fg !m-0">
                  {preChildren}
                </pre>
              </div>
            );
          },
          a({ href, children: linkChildren }) {
            const safeHref =
              href && /^(https?:|mailto:|\/|#)/i.test(href) ? href : "#";
            return (
              <a
                href={safeHref}
                target="_blank"
                rel="noopener noreferrer nofollow"
              >
                {linkChildren}
              </a>
            );
          },
          img({ alt }) {
            return (
              <span className="text-xs italic text-muted">
                [Image: {alt || "image"}]
              </span>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
