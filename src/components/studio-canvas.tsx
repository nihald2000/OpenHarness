"use client";

import { useEffect, useMemo, useState } from "react";
import { Download, FileSpreadsheet, FileText, Image as ImageIcon, Map, Presentation, Layers, PanelRightClose } from "lucide-react";
import { client } from "@/lib/client";

const tiles = [
  ["Slide Deck", "Create a polished slide deck from session sources and verify its pages.", Presentation],
  ["Infographic", "Create a branded infographic from the session sources.", ImageIcon],
  ["Mind Map", "Create an interactive mind map of the key ideas in the session.", Map],
  ["Executive Report", "Create an illustrated executive report with source citations.", FileText],
  ["Spreadsheet Model", "Create a multi-sheet model from the session sources and audit formulas.", FileSpreadsheet],
  ["Interactive App", "Create a self-contained interactive dashboard from the session sources.", Layers],
] as const;

export function StudioCanvas({ sessionId, files, onClose, onCreate, onEdit, initialPath }: {
  sessionId: string; files: string[]; onClose: () => void; onCreate: (prompt: string) => void; onEdit?: (prompt: string) => void; initialPath?: string;
}) {
  const [sessionFiles, setSessionFiles] = useState(files);
  const candidates = useMemo(() => sessionFiles.filter((file) => /\.(pdf|docx|xlsx|xlsm|pptx|csv|tsv|png|jpe?g|webp|gif|svg|html|md)$/i.test(file)), [sessionFiles]);
  const [selected, setSelected] = useState("");
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const [inspectError, setInspectError] = useState("");
  const [fallbackText, setFallbackText] = useState("");
  const [inspectAttempt, setInspectAttempt] = useState(0);
  const [styleHint, setStyleHint] = useState("");
  const [slide, setSlide] = useState(0);
  const [activeSheet, setActiveSheet] = useState(0);
  const [present, setPresent] = useState(false);
  const [showFormulas, setShowFormulas] = useState(false);
  const [documentView, setDocumentView] = useState<"pages" | "native" | "outline">("pages");
  const [zoom, setZoom] = useState(100);
  useEffect(() => {
    setSelected(""); setDetail(null); setSlide(0); setActiveSheet(0); setSessionFiles(files);
    let active = true;
    void client.session.files(sessionId).then((result) => { if (active) setSessionFiles(Array.from(new Set([...files, ...result.files]))); }).catch(() => {});
    return () => { active = false; };
  }, [sessionId]);
  useEffect(() => { setSessionFiles((current) => Array.from(new Set([...current, ...files]))); }, [files]);
  useEffect(() => { if (initialPath) setSelected(initialPath); }, [initialPath]);
  useEffect(() => {
    if (!selected && candidates.length) setSelected(candidates[candidates.length - 1]!);
  }, [candidates, selected]);
  useEffect(() => {
    let active = true;
    if (!selected) { setDetail(null); setBusy(false); setInspectError(""); return; }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12_000);
    setDetail(null); setInspectError(""); setFallbackText("");
    setBusy(true);
    void client.session.inspectFile(sessionId, selected, controller.signal).then((result) => { if (active) setDetail(result); })
      .catch((error: unknown) => {
        if (!active) return;
        setInspectError(error instanceof Error ? error.message : "Could not inspect this artifact");
        if (/\.md$/i.test(selected)) {
          void client.session.file(sessionId, selected).then((file) => { if (active) setFallbackText(file.content); }).catch(() => {});
        }
      }).finally(() => { window.clearTimeout(timeout); if (active) setBusy(false); });
    return () => { active = false; window.clearTimeout(timeout); controller.abort(); };
  }, [sessionId, selected, inspectAttempt]);
  const kind = String(detail?.kind ?? "");
  const pages = Array.isArray(detail?.pages) ? detail.pages as Array<Record<string, unknown>>
    : Array.isArray(detail?.slides) ? (detail.slides as Array<Record<string, unknown>>).map((item) => ({ ...item, dataBase64: item.previewDataBase64 })) : [];
  const sheets = Array.isArray(detail?.sheets) ? detail.sheets as Array<Record<string, unknown>> : [];
  const url = selected ? client.session.fileRawUrl(sessionId, selected) : "";
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPresent(false);
      if (event.key === "ArrowRight" || event.key === " ") setSlide((value) => Math.min(pages.length - 1, value + 1));
      if (event.key === "ArrowLeft") setSlide((value) => Math.max(0, value - 1));
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [pages.length]);
  const ext = selected.split(".").at(-1)?.toLowerCase() ?? "";
  const stage = !selected ? <div className="grid h-full place-items-center p-8 text-center text-sm text-muted">Choose a source or artifact to preview it here, or create one with Studio.</div>
    : busy ? <div className="p-8 text-sm text-muted">Preparing preview…</div>
    : inspectError && ["png", "jpg", "jpeg", "webp", "gif", "svg"].includes(ext) ? <div className="grid min-h-80 place-items-center bg-neutral-950 p-4"><img src={url} alt={selected} className="max-h-[70vh] max-w-full object-contain" /></div>
    : inspectError && ext === "pdf" ? <iframe title={selected} src={url} className="h-[65vh] w-full bg-white" />
    : inspectError && ext === "html" ? <iframe title={selected} src={url} sandbox="allow-scripts" className="h-[65vh] w-full bg-white" />
    : inspectError && ext === "md" && fallbackText ? <article className="overflow-auto p-5 text-sm whitespace-pre-wrap">{fallbackText}</article>
    : inspectError ? <div className="m-6 rounded-xl border border-border bg-elev p-5"><h3 className="font-semibold">Preview unavailable</h3><p className="my-2 text-sm text-muted">{inspectError}</p><div className="flex gap-2"><button type="button" onClick={() => setInspectAttempt((value) => value + 1)} className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white">Retry preview</button><a href={client.session.fileRawUrl(sessionId, selected, { download: true })} className="rounded-lg border border-border px-3 py-2 text-sm">Download</a></div></div>
    : kind === "image" ? <div className="grid min-h-80 place-items-center bg-neutral-950 p-4"><img src={url} alt={selected} className="max-h-[70vh] max-w-full object-contain" /></div>
    : kind === "html_artifact" ? <iframe title={selected} srcDoc={String(detail?.content ?? "")} sandbox="allow-scripts" className="h-[65vh] w-full bg-white" />
    : kind === "markdown_artifact" ? <article className="overflow-auto p-5 text-sm whitespace-pre-wrap">{String(detail?.content ?? "")}</article>
    : kind === "spreadsheet" ? <div className="overflow-auto p-3"><div className="mb-3 flex items-center gap-3"><span className={Array.isArray(detail?.formulaErrors) && detail.formulaErrors.length ? "rounded-full bg-danger/10 px-2 py-1 text-xs text-danger" : "rounded-full bg-green-500/10 px-2 py-1 text-xs text-green-700"}>{Array.isArray(detail?.formulaErrors) ? detail.formulaErrors.length + " formula errors" : "Formula audit clean"}</span><label className="text-xs text-muted"><input type="checkbox" checked={showFormulas} onChange={(event) => setShowFormulas(event.target.checked)} /> Show formulas</label></div><div className="mb-3 flex gap-1 overflow-x-auto border-b border-border">{sheets.map((sheet, index) => <button key={String(sheet.name ?? index)} type="button" onClick={() => setActiveSheet(index)} className={"shrink-0 border-b-2 px-3 py-2 text-xs " + (activeSheet === index ? "border-accent text-accent" : "border-transparent text-muted")}>{String(sheet.name ?? ("Sheet " + (index + 1)))}</button>)}</div>{sheets[activeSheet] && <section className="overflow-auto"><table className="min-w-full border-collapse text-xs">{Array.isArray(sheets[activeSheet]!.rows) && (sheets[activeSheet]!.rows as Array<Array<Record<string, unknown>>>).slice(0, 250).map((row, ri) => <tr key={ri}><th className="border border-border bg-elev px-2 py-1 text-muted">{ri + 1}</th>{row.slice(0, 30).map((cell, ci) => <td key={ci} className={"max-w-56 border border-border px-2 py-1 " + (cell.error ? "bg-danger/10 text-danger" : cell.formula ? "bg-accent/5" : "")}>{String(showFormulas && cell.formula ? cell.formula : cell?.value ?? "")}</td>)}</tr>)}</table></section>}</div>
    : kind === "document" ? <div className="h-full overflow-auto"><div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-bg/95 p-2"><div className="flex gap-1">{(["pages", ...(detail?.isNativePdf === true ? ["native"] : []), "outline"] as Array<"pages" | "native" | "outline">).map((view) => <button key={view} onClick={() => setDocumentView(view)} className={"rounded px-2 py-1 text-xs " + (documentView === view ? "bg-accent text-white" : "text-muted")}>{view === "pages" ? "Rendered Pages" : view === "native" ? "Native PDF" : "Outline & Text"}</button>)}</div><div className="flex items-center gap-2 text-xs"><button onClick={() => setZoom((value) => Math.max(75, value - 25))}>−</button><span>{zoom}%</span><button onClick={() => setZoom((value) => Math.min(150, value + 25))}>+</button></div></div>{documentView === "native" && detail?.isNativePdf === true ? <iframe title={selected} src={url} className="h-[75vh] w-full" /> : documentView === "outline" ? <div className="p-4"><ol className="mb-4 list-decimal pl-6">{Array.isArray(detail?.headings) && (detail.headings as Array<{ level: number; text: string }>).map((heading, index) => <li key={index} style={{ marginLeft: Math.max(0, heading.level - 1) * 12 }}>{heading.text}</li>)}</ol><pre className="whitespace-pre-wrap text-sm">{String(detail?.markdownPreview ?? "")}</pre></div> : <div className="space-y-4 p-3">{pages.map((page, index) => <div key={index} className="flex justify-center"><img src={typeof page.dataBase64 === "string" ? "data:image/jpeg;base64," + page.dataBase64 : url} alt={"Page " + (index + 1)} style={{ width: zoom + "%" }} className="max-w-full border border-border bg-white shadow" /></div>)}</div>}</div>
    : pages.length ? <div className="flex min-h-[420px] flex-col items-center justify-center gap-3 bg-neutral-950 p-4"><div className="grid w-full max-w-5xl place-items-center overflow-hidden rounded bg-white" style={{ aspectRatio: "16 / 9" }}>{pages[slide]?.dataBase64 ? <img src={"data:image/jpeg;base64," + String(pages[slide]?.dataBase64)} alt={"Page " + (slide + 1)} className="max-h-full max-w-full object-contain" /> : <iframe title={selected} src={url} sandbox="allow-scripts" className="h-full w-full bg-white" />}</div>{pages.length > 1 && <div className="flex max-w-full gap-2 overflow-x-auto">{pages.map((page, index) => <button type="button" key={index} onClick={() => setSlide(index)} aria-label={`Show slide ${index + 1}`} className={"shrink-0 overflow-hidden rounded border-2 " + (slide === index ? "border-accent" : "border-white/20")}>{page.dataBase64 ? <img src={`data:image/jpeg;base64,${String(page.dataBase64)}`} alt="" className="h-14 w-24 object-cover" /> : <span className="grid h-14 w-24 place-items-center text-xs text-white">{index + 1}</span>}</button>)}</div>}<div className="flex items-center gap-3 text-xs text-white"><button onClick={() => setSlide((value) => Math.max(0, value - 1))}>‹</button><span>{Math.min(slide + 1, Math.max(1, pages.length))} / {Math.max(1, pages.length)}</span><button onClick={() => setSlide((value) => Math.min(Math.max(0, pages.length - 1), value + 1))}>›</button><button onClick={() => setPresent(true)}>Present</button></div></div>
    : <iframe title={selected} src={url} sandbox="allow-scripts" className="h-[65vh] w-full bg-white" />;
  return <>
    {present && <div className="fixed inset-0 z-[100] grid place-items-center bg-black p-8">{stage}<button type="button" onClick={() => setPresent(false)} className="absolute right-5 top-5 rounded bg-white px-3 py-2 text-black">Exit presentation</button></div>}
    <div role="separator" aria-label="Studio dock divider" className="hidden w-1 bg-border md:block" />
    <aside aria-label="Studio Canvas" className="fixed inset-0 z-40 flex min-w-0 flex-col border-l border-border bg-bg md:static md:z-auto md:w-full md:overflow-hidden">
      <header className="flex items-center justify-between border-b border-border px-4 py-3"><div><div className="font-semibold">Studio</div><div className="text-xs text-muted">{candidates.length} artifacts and sources</div></div><button type="button" aria-label="Close Studio" onClick={onClose} className="rounded border border-border p-2"><PanelRightClose size={15} /></button></header>
      <section className="border-b border-border p-3"><div className="mb-2 text-xs font-medium text-muted">Create with Studio</div><label className="mb-2 block"><span className="sr-only">Optional style or palette</span><input value={styleHint} onChange={(event) => setStyleHint(event.target.value)} placeholder="Optional style or palette" className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-xs" /></label><div className="grid grid-cols-2 gap-2">{tiles.map(([label, prompt, Icon]) => <button key={label} type="button" onClick={() => onCreate(`${prompt}${styleHint.trim() ? ` Style/palette: ${styleHint.trim()}.` : ""}`)} className="flex items-center gap-2 rounded-lg border border-border bg-elev px-2 py-2 text-left text-xs hover:border-accent"><Icon size={15} />{label}</button>)}</div></section>
      <div className="flex gap-2 overflow-x-auto border-b border-border p-2">{candidates.map((file) => <button type="button" key={file} onClick={() => { setSelected(file); setSlide(0); setActiveSheet(0); setDocumentView("pages"); }} className={"shrink-0 rounded-full border px-3 py-1.5 text-xs " + (selected === file ? "border-accent text-accent" : "border-border text-muted")}>{file.split(/[\\/]/).at(-1)}</button>)}</div>
      <main className="min-h-0 flex-1 overflow-auto">{stage}</main>
      {selected && <footer className="flex items-center justify-between border-t border-border p-3 text-xs"><button type="button" onClick={() => { const scope = kind === "presentation" ? `active slide ${slide + 1}` : kind === "spreadsheet" ? `active sheet ${String(sheets[activeSheet]?.name ?? "Sheet " + (activeSheet + 1))}` : "selected content"; onEdit?.(`Update ${selected}, focusing on ${scope}. Apply this instruction to the selected artifact and preserve its other content: `); }} className="rounded-lg bg-accent px-3 py-2 font-medium text-white">Edit selection with Assistant</button><a href={client.session.fileRawUrl(sessionId, selected, { download: true })} className="inline-flex items-center gap-1 text-accent"><Download size={14} /> Download</a></footer>}
    </aside>
  </>;
}
