"""Structured, dependency-tolerant document operations for oh-sandboxd."""
import base64
import csv
import io
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import zipfile
import xml.etree.ElementTree as ET


def render_card(title, lines, page):
    from PIL import Image, ImageDraw, ImageFont
    image = Image.new("RGB", (1280, 800), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default()
    draw.rectangle((0, 0, 1280, 92), fill=(27, 42, 67))
    draw.text((48, 34), str(title)[:100], fill="white", font=font)
    y = 128
    for line in lines[:32]:
        draw.text((56, y), str(line)[:160], fill=(32, 42, 55), font=font)
        y += 21
    output = io.BytesIO()
    image.save(output, format="JPEG", quality=84)
    return {"page": page, "mimeType": "image/jpeg", "dataBase64": base64.b64encode(output.getvalue()).decode()}


def rasterize_pdf_cli(pdf_path, limit):
    if not shutil.which("pdftoppm"):
        return []
    temp = tempfile.mkdtemp(prefix="oh-raster-")
    try:
        prefix = pathlib.Path(temp) / "page"
        result = subprocess.run(["pdftoppm", "-f", "1", "-l", str(limit), "-jpeg", "-jpegopt", "quality=82", "-r", "144", "-scale-to", "1600", str(pdf_path), str(prefix)], capture_output=True, timeout=45)
        if result.returncode:
            return []
        images = sorted(pathlib.Path(temp).glob("page-*.jpg"))
        return [{"page": index + 1, "mimeType": "image/jpeg", "dataBase64": base64.b64encode(image.read_bytes()).decode()} for index, image in enumerate(images[:limit])]
    except Exception:
        return []
    finally:
        shutil.rmtree(temp, ignore_errors=True)


def office_pdf_pages(source, limit):
    if not shutil.which("soffice") or not shutil.which("pdftoppm"):
        return []
    temp, profile = tempfile.mkdtemp(prefix="oh-office-preview-"), tempfile.mkdtemp(prefix="oh-lo-profile-")
    try:
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": temp, "TMPDIR": temp, "LANG": "C.UTF-8"}
        output = subprocess.run(["soffice", "-env:UserInstallation=file://" + profile, "--headless", "--convert-to", "pdf", "--outdir", temp, str(source)], capture_output=True, text=True, timeout=45, env=env)
        pdf = pathlib.Path(temp) / (source.stem + ".pdf")
        if output.returncode or not pdf.is_file():
            return []
        return rasterize_pdf_cli(pdf, limit)
    except Exception:
        return []
    finally:
        shutil.rmtree(temp, ignore_errors=True)
        shutil.rmtree(profile, ignore_errors=True)


def extract_text(path):
    ext = path.suffix.lower()
    if ext == ".pdf":
        from pypdf import PdfReader
        return "\n\n".join(page.extract_text() or "" for page in PdfReader(str(path)).pages)
    if ext == ".docx":
        from docx import Document
        doc = Document(str(path))
        text = [p.text for p in doc.paragraphs]
        text += [" | ".join(cell.text for cell in row.cells) for table in doc.tables for row in table.rows]
        return "\n".join(text)
    if ext in (".xlsx", ".xlsm"):
        import openpyxl
        book = openpyxl.load_workbook(path, data_only=False, read_only=True)
        return "\n\n".join("# " + sheet.title + "\n" + "\n".join(
            "| " + " | ".join("" if cell.value is None else str(cell.value) for cell in row) + " |"
            for row in sheet.iter_rows(max_row=100, max_col=20)) for sheet in book.worksheets)
    if ext == ".pptx":
        from pptx import Presentation
        deck = Presentation(str(path))
        return "\n\n".join("# Slide " + str(i + 1) + "\n" + "\n".join(
            shape.text for shape in slide.shapes if getattr(shape, "has_text_frame", False))
            for i, slide in enumerate(deck.slides))
    return path.read_text(encoding="utf-8", errors="replace")


def preview(path, limit):
    ext = path.suffix.lower()
    pages, sheets, errors = [], [], []
    if ext in (".xlsx", ".xlsm"):
        import openpyxl
        formulas = openpyxl.load_workbook(path, data_only=False, read_only=True)
        values = openpyxl.load_workbook(path, data_only=True, read_only=True)
        for sheet in formulas.worksheets[:12]:
            cached = values[sheet.title]
            lines = []
            for row in sheet.iter_rows(max_row=60, max_col=12):
                cells = []
                for cell in row:
                    value = cached[cell.coordinate].value
                    cells.append("" if cell.value is None else str(cell.value))
                    if isinstance(value, str) and value.startswith("#") and value in ("#REF!", "#DIV/0!", "#VALUE!", "#NAME?", "#N/A", "#NUM!"):
                        errors.append(sheet.title + "!" + cell.coordinate + " " + value)
                    if isinstance(cell.value, str) and cell.value.startswith("=") and isinstance(value, str) and value.startswith("#"):
                        errors.append(sheet.title + "!" + cell.coordinate + " " + value)
                lines.append(" | ".join(cells))
            sheets.append({"name": sheet.title, "rows": sheet.max_row, "columns": sheet.max_column})
            pages.append(render_card(sheet.title, lines, len(pages) + 1))
        formulas.close()
        values.close()
    elif ext in (".png", ".jpg", ".jpeg", ".webp", ".gif"):
        from PIL import Image
        image = Image.open(path).convert("RGB")
        image.thumbnail((1600, 1200))
        output = io.BytesIO()
        image.save(output, format="JPEG", quality=86)
        pages.append({"page": 1, "mimeType": "image/jpeg", "dataBase64": base64.b64encode(output.getvalue()).decode()})
    elif ext == ".pdf":
        pages = rasterize_pdf_cli(path, limit)
        if pages:
            try:
                from pypdf import PdfReader
                total = len(PdfReader(str(path)).pages)
            except Exception:
                total = len(pages)
            return {"path": path.name, "pageCount": total, "sheets": [], "formulaErrors": [], "pages": pages}
        try:
            import pypdfium2 as pdfium
            document = pdfium.PdfDocument(str(path))
            total = len(document)
            for index in range(min(limit, total)):
                image = document[index].render(scale=1.6).to_pil().convert("RGB")
                image.thumbnail((1800, 2400))
                output = io.BytesIO()
                image.save(output, format="JPEG", quality=86)
                pages.append({"page": index + 1, "mimeType": "image/jpeg", "dataBase64": base64.b64encode(output.getvalue()).decode()})
        except ImportError:
            from pypdf import PdfReader
            document = PdfReader(str(path))
            total = len(document.pages)
            for index, page in enumerate(document.pages[:limit]):
                pages.append(render_card("Page " + str(index + 1), (page.extract_text() or "").splitlines(), index + 1))
    elif ext == ".docx":
        lines = extract_text(path).splitlines()
        pages.append(render_card(path.name, lines, 1))
    elif ext == ".pptx":
        from pptx import Presentation
        deck = Presentation(str(path))
        total = len(deck.slides)
        for index, slide in enumerate(deck.slides[:limit]):
            lines = [shape.text for shape in slide.shapes if getattr(shape, "has_text_frame", False)]
            pages.append(render_card("Slide " + str(index + 1), lines, index + 1))
    else:
        pages.append(render_card(path.name, extract_text(path).splitlines(), 1))
    if ext in (".docx", ".xlsx", ".xlsm", ".pptx", ".odt", ".ods", ".odp", ".rtf"):
        office_pages = office_pdf_pages(path, limit)
        if office_pages:
            pages = office_pages
    return {"path": path.name, "pageCount": locals().get("total", max(1, len(pages))),
            "sheets": sheets, "formulaErrors": errors, "pages": pages}


def inspect(path):
    ext = path.suffix.lower()
    size = path.stat().st_size
    if ext in (".csv", ".tsv"):
        delimiter = "\t" if ext == ".tsv" else ","
        with path.open(encoding="utf-8-sig", errors="replace", newline="") as stream:
            rows = list(csv.reader(stream, delimiter=delimiter))[:250]
        rows = [row[:30] for row in rows]
        return {"kind": "spreadsheet", "path": str(path), "size": size, "formulaErrors": [],
                "sheets": [{"name": "Sheet1", "rowCount": len(rows), "colCount": max(map(len, rows), default=0),
                            "headers": rows[0] if rows else [], "rows": [[{"value": value} for value in row] for row in rows]}]}
    if ext in (".xlsx", ".xlsm"):
        import openpyxl
        book = openpyxl.load_workbook(path, data_only=False, read_only=True)
        cached = openpyxl.load_workbook(path, data_only=True, read_only=True)
        sheets = []
        errors = []
        for sheet in book.worksheets[:12]:
            cached_sheet = cached[sheet.title]
            rows = [[{"value": cell.value, **({"formula": cell.value} if isinstance(cell.value, str) and cell.value.startswith("=") else {}),
                      **({"error": True} if isinstance(cached_sheet[cell.coordinate].value, str) and cached_sheet[cell.coordinate].value.startswith("#") else {})}
                     for cell in row] for row in sheet.iter_rows(max_row=250, max_col=30)]
            for row in sheet.iter_rows():
                for cell in row:
                    value = cached_sheet[cell.coordinate].value
                    if isinstance(cell.value, str) and cell.value.startswith("=") and isinstance(value, str) and value in ("#REF!", "#DIV/0!", "#VALUE!", "#NAME?", "#N/A", "#NUM!"):
                        errors.append(sheet.title + "!" + cell.coordinate + " " + value)
            sheets.append({"name": sheet.title, "rowCount": sheet.max_row, "colCount": sheet.max_column,
                           "headers": [str(cell.value or "") for cell in next(sheet.iter_rows(max_row=1), [])],
                           "rows": rows})
        book.close()
        cached.close()
        return {"kind": "spreadsheet", "path": str(path), "size": size, "formulaErrors": errors, "sheets": sheets}
    if ext in (".html", ".md"):
        return {"kind": "html_artifact" if ext == ".html" else "markdown_artifact", "path": str(path), "size": size,
                "content": path.read_text(encoding="utf-8", errors="replace")[:512 * 1024]}
    if ext in (".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"):
        dims = {}
        if ext != ".svg":
            from PIL import Image
            with Image.open(path) as image:
                dims = {"width": image.width, "height": image.height}
        return {"kind": "image", "path": str(path), "size": size, **dims}
    if ext == ".pptx":
        from pptx import Presentation
        deck = Presentation(str(path))
        slides = []
        for index, slide in enumerate(deck.slides):
            blocks = [shape.text.strip() for shape in slide.shapes if getattr(shape, "has_text_frame", False) and shape.text.strip()]
            notes = ""
            try:
                notes = slide.notes_slide.notes_text_frame.text
            except Exception:
                pass
            slides.append({"index": index, "title": blocks[0] if blocks else "Slide " + str(index + 1), "bullets": blocks[1:], "notes": notes})
        rendered = preview(path, min(20, len(slides)))
        for index, item in enumerate(slides):
            if index < len(rendered["pages"]):
                item["previewDataBase64"] = rendered["pages"][index]["dataBase64"]
        return {"kind": "presentation", "path": str(path), "size": size, "slideCount": len(slides), "slides": slides}
    if ext in (".docx", ".pdf", ".odt", ".epub", ".rtf"):
        markdown = extract_text(path)
        headings = []
        if ext == ".docx":
            try:
                from docx import Document
                for paragraph in Document(str(path)).paragraphs:
                    style = paragraph.style.name.lower()
                    if paragraph.text.strip() and "heading" in style:
                        digits = "".join(ch for ch in style if ch.isdigit())
                        headings.append({"level": int(digits or "1"), "text": paragraph.text.strip()})
            except Exception:
                pass
        elif ext == ".pdf":
            headings = [{"level": 1, "text": line.strip(" #") } for line in markdown.splitlines() if line.strip().startswith("#")]
        rendered = preview(path, 4)
        return {"kind": "document", "path": str(path), "size": size, "pages": rendered["pages"], "headings": headings, "markdownPreview": markdown[:100000], "isNativePdf": ext == ".pdf"}
    result = preview(path, 20)
    kind = "presentation" if ext in (".pptx", ".odp") else "document"
    return {"kind": kind, **result, "size": size}


def main():
    action = sys.argv[1]
    args = json.loads(base64.b64decode(sys.argv[2]))
    path = pathlib.Path(args["path"])
    if action == "preview":
        result = preview(path, max(1, min(20, int(args.get("maxPages", 4)))))
    elif action == "extract":
        result = {"path": args.get("rawPath", str(path)), "markdown": extract_text(path)[:max(1, min(100000, int(args.get("maxChars", 40000))))]}
    elif action == "inspect":
        result = inspect(path)
    elif action == "convert":
        output = pathlib.Path(args["output"])
        output.parent.mkdir(parents=True, exist_ok=True)
        if output.suffix.lower() in (".md", ".txt"):
            shutil.copyfile(path, output)
        elif output.suffix.lower() == ".pdf":
            temp, profile = tempfile.mkdtemp(prefix="oh-convert-"), tempfile.mkdtemp(prefix="lo-prof-")
            try:
                env = os.environ.copy()
                env.update({"HOME": temp, "TMPDIR": temp})
                completed = subprocess.run(["soffice", "-env:UserInstallation=file://" + profile, "--headless",
                                            "--convert-to", "pdf", "--outdir", temp, str(path)],
                                           capture_output=True, text=True, timeout=45, env=env)
                made = pathlib.Path(temp) / (path.stem + ".pdf")
                if completed.returncode or not made.exists():
                    try:
                        from reportlab.lib.pagesizes import letter
                        from reportlab.pdfgen import canvas
                        writer = canvas.Canvas(str(output), pagesize=letter)
                        y = 750
                        for line in extract_text(path).splitlines():
                            writer.drawString(48, y, line[:110])
                            y -= 14
                            if y < 48:
                                writer.showPage()
                                y = 750
                        writer.save()
                    except Exception as fallback_error:
                        raise RuntimeError((completed.stderr or completed.stdout or str(fallback_error) or "PDF conversion unavailable")[-1500:])
                else:
                    shutil.copyfile(made, output)
            finally:
                shutil.rmtree(temp, ignore_errors=True)
                shutil.rmtree(profile, ignore_errors=True)
        else:
            raise RuntimeError("Conversion target is unsupported by the installed converters")
        result = {"inputPath": args.get("rawPath"), "outputPath": args.get("outputPath"), "size": output.stat().st_size}
    else:
        raise RuntimeError("Unknown artifact operation")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
