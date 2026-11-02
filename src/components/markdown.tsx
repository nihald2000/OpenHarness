import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CopyButton } from "./copy-button";
import { client } from "@/lib/client";

function mermaidSvg(source: string): string {
  const esc = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" })[char]!);
  const nodes = new Map<string, string>();
  const edges: Array<[string, string]> = [];
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*([\w-]+)(?:\[([^\]]*)\]|\(([^)]*)\))?\s*[-.]+>\s*([\w-]+)(?:\[([^\]]*)\]|\(([^)]*)\))?/);
    if (!match) continue;
    const [, from, fromBox, fromRound, to, toBox, toRound] = match;
    nodes.set(from!, fromBox ?? fromRound ?? from!); nodes.set(to!, toBox ?? toRound ?? to!); edges.push([from!, to!]);
  }
  if (!nodes.size) return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 160"><text x="24" y="80" font-family="sans-serif" font-size="20">${esc(source.slice(0, 120))}</text></svg>`;
  const entries = [...nodes.entries()];
  const width = 900, row = 110, height = Math.max(200, entries.length * row + 70);
  const positions = new Map(entries.map(([id], index) => [id, { x: 450, y: 50 + index * row }]));
  const edgeSvg = edges.map(([from, to]) => { const a = positions.get(from)!, b = positions.get(to)!; return `<path d="M ${a.x} ${a.y + 24} L ${b.x} ${b.y - 24}" stroke="#94a3b8" stroke-width="3" marker-end="url(#arrow)"/>`; }).join("");
  const nodeSvg = entries.map(([id, label]) => { const p = positions.get(id)!; return `<g><rect x="${p.x - 150}" y="${p.y - 26}" width="300" height="52" rx="14" fill="#f8fafc" stroke="#64748b" stroke-width="2"/><text x="${p.x}" y="${p.y + 6}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="18" fill="#0f172a">${esc(label.slice(0, 48))}</text></g>`; }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" height="100%"><defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#94a3b8"/></marker></defs>${edgeSvg}${nodeSvg}</svg>`;
}

export function Markdown({
  children,
  streaming = false,
  className = "",
  sessionId,
  onOpenArtifact,
}: {
  children: string;
  streaming?: boolean;
  className?: string;
  sessionId?: string;
  onOpenArtifact?: (filePath: string) => void;
}) {
  const [lightbox, setLightbox] = React.useState<string | null>(null);
  const imageUrl = (src?: string) => {
    if (!src) return null;
    if (/^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(src) || /^(?:https?:|\/v1\/)/i.test(src)) return src;
    const clean = src.replace(/^\.\//, "").replace(/^workspace\//, "");
    return sessionId && /\.(?:png|jpe?g|webp|gif|svg)$/i.test(clean) ? client.session.fileRawUrl(sessionId, clean) : null;
  };
  return (
    <div
      className={`markdown text-base leading-normal ${
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

            if (!streaming && ["svg", "html-visual", "mermaid"].includes(lang.toLowerCase())) {
              const srcDoc = lang.toLowerCase() === "svg"
                ? `<html><body style="margin:0;display:grid;place-items:center;min-height:100vh">${codeText}</body></html>`
                : lang.toLowerCase() === "mermaid"
                  ? `<html><body style="margin:0;display:grid;place-items:center;min-height:100vh">${mermaidSvg(codeText)}</body></html>`
                : codeText;
              return <div className="my-4 overflow-hidden rounded-xl border border-border bg-elev">
                <div className="flex items-center justify-between border-b border-border px-3 py-2 text-xs text-muted"><span>Live visual · sandboxed</span><CopyButton text={codeText} label="Copy source" /></div>
                <iframe title="Inline visual" sandbox={lang.toLowerCase() === "html-visual" ? "allow-scripts" : ""} srcDoc={srcDoc} className="h-[360px] w-full bg-white" />
                <details className="border-t border-border"><summary className="cursor-pointer px-3 py-2 text-xs text-muted">View source</summary><pre className="max-h-64 overflow-auto p-3 text-xs">{codeText}</pre></details>
              </div>;
            }

            return (
              <div className="my-3 overflow-hidden rounded-xl border border-border bg-code">
                <div className="flex items-center justify-between border-b border-border bg-bg/60 px-3 py-2 text-xs font-mono text-muted">
                  <span>{lang}</span>
                  <CopyButton text={codeText} label="Copy code" />
                </div>
                <pre className="overflow-x-auto p-4 font-mono text-sm leading-normal text-fg !m-0">
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
          img({ alt, src }) {
            const url = imageUrl(src);
            const clean = src?.replace(/^\.\//, "").replace(/^workspace\//, "");
            if (!url) return <span className="text-xs italic text-muted">[Image unavailable: {alt || src || "image"}]</span>;
            return <figure className="group relative my-4 w-fit max-w-full overflow-hidden rounded-xl border border-border bg-elev">
              <button type="button" className="block max-w-full" onClick={() => setLightbox(url)} aria-label={`Expand ${alt || "image"}`}><img src={url} alt={alt || "Workspace image"} loading="lazy" className="max-h-[440px] max-w-full bg-bg/60 object-contain" /></button>
              <figcaption className="flex items-center justify-between gap-3 border-t border-border px-3 py-2 text-xs text-muted"><span className="truncate">{alt || clean}</span><span className="flex shrink-0 gap-3">{clean && sessionId && <button type="button" onClick={() => onOpenArtifact ? onOpenArtifact(clean) : window.dispatchEvent(new CustomEvent("oh:open-artifact", { detail: { path: clean } }))} className="text-accent">Open in Studio</button>}{clean && sessionId && <a href={client.session.fileRawUrl(sessionId, clean, { download: true })} className="text-accent">Download</a>}<button type="button" onClick={() => setLightbox(url)} className="text-accent">Expand</button></span></figcaption>
              {lightbox === url && <div role="dialog" aria-modal="true" className="fixed inset-0 z-[100] grid place-items-center bg-black/80 p-6" onClick={() => setLightbox(null)}><button type="button" aria-label="Close image" className="absolute right-5 top-5 text-white">Close</button><img src={url} alt={alt || "Expanded image"} className="max-h-full max-w-full object-contain" /></div>}
            </figure>;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
