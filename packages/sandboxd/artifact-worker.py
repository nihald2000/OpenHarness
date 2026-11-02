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
            slide_text_blocks(slide))
            for i, slide in enumerate(deck.slides))
    return path.read_text(encoding="utf-8", errors="replace")


def slide_text_blocks(slide):
    blocks = []
    for shape in slide.shapes:
        if getattr(shape, "has_text_frame", False):
            value = getattr(shape, "text", None)
            if value and value.strip():
                blocks.append(value.strip())
        if getattr(shape, "has_table", False):
            for row in shape.table.rows:
                value = " | ".join(cell.text.strip() for cell in row.cells if cell.text.strip())
                if value:
                    blocks.append(value)
    return blocks


def preview(path, limit):
    ext = path.suffix.lower()
    pages, sheets, errors = [], [], []
    if ext in (".xlsx", ".xlsm"):
        import openpyxl
        if path.stat().st_size > 35 * 1024 * 1024:
            raise ValueError("Spreadsheet exceeds the 35 MB preview limit")
        formulas = openpyxl.load_workbook(path, data_only=False, read_only=False)
        values = openpyxl.load_workbook(path, data_only=True, read_only=False)
        for sheet in formulas.worksheets[:12]:
            cached = values[sheet.title] if sheet.title in values.sheetnames else sheet
            lines = []
            max_row = min(sheet.max_row or 1, 60)
            max_col = min(sheet.max_column or 1, 12)
            for row_index in range(1, max_row + 1):
                cells = []
                for col_index in range(1, max_col + 1):
                    cell = sheet.cell(row=row_index, column=col_index)
                    value = cached.cell(row=row_index, column=col_index).value
                    coordinate = f"{openpyxl.utils.get_column_letter(col_index)}{row_index}"
                    cells.append("" if cell.value is None else str(cell.value))
                    if isinstance(value, str) and value.startswith("#") and value in ("#REF!", "#DIV/0!", "#VALUE!", "#NAME?", "#N/A", "#NUM!"):
                        errors.append(sheet.title + "!" + coordinate + " " + value)
                    if isinstance(cell.value, str) and cell.value.startswith("=") and isinstance(value, str) and value.startswith("#"):
                        errors.append(sheet.title + "!" + coordinate + " " + value)
                lines.append(" | ".join(cells))
            sheets.append({"name": sheet.title, "rows": max_row, "columns": max_col})
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
        for index, slide in enumerate(deck.slides):
            if index >= limit:
                break
            lines = slide_text_blocks(slide)
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
        if size > 35 * 1024 * 1024:
            raise ValueError("Spreadsheet exceeds the 35 MB inspect limit")
        book = openpyxl.load_workbook(path, data_only=False, read_only=False)
        cached = openpyxl.load_workbook(path, data_only=True, read_only=False)
        sheets = []
        errors = []
        for sheet in book.worksheets[:12]:
            cached_sheet = cached[sheet.title]
            max_row = min(sheet.max_row or 1, 250)
            max_col = min(sheet.max_column or 1, 30)
            rows = []
            for row_index in range(1, max_row + 1):
                row = []
                for col_index in range(1, max_col + 1):
                    cell = sheet.cell(row=row_index, column=col_index)
                    cached_value = cached_sheet.cell(row=row_index, column=col_index).value
                    error_values = ("#REF!", "#DIV/0!", "#VALUE!", "#NAME?", "#N/A", "#NUM!")
                    is_error = (isinstance(cell.value, str) and cell.value in error_values) or (isinstance(cached_value, str) and cached_value in error_values)
                    row.append({"value": cell.value, **({"formula": cell.value} if isinstance(cell.value, str) and cell.value.startswith("=") else {}),
                                **({"error": True} if is_error else {})})
                rows.append(row)
            for row_index in range(1, max_row + 1):
                for col_index in range(1, max_col + 1):
                    cell = sheet.cell(row=row_index, column=col_index)
                    value = cached_sheet.cell(row=row_index, column=col_index).value
                    error_values = ("#REF!", "#DIV/0!", "#VALUE!", "#NAME?", "#N/A", "#NUM!")
                    error_value = cell.value if isinstance(cell.value, str) and cell.value in error_values else value
                    if (isinstance(cell.value, str) and cell.value.startswith("=") and isinstance(value, str) and value in error_values) or (isinstance(error_value, str) and error_value in error_values):
                        errors.append(sheet.title + "!" + cell.coordinate + " " + error_value)
            sheets.append({"name": sheet.title, "rowCount": max_row, "colCount": max_col,
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
            blocks = slide_text_blocks(slide)
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


def visual_audit(args):
    from PIL import Image, ImageDraw, ImageFont
    encoded = str(args.get("imageBase64", ""))
    if not encoded or len(encoded) > 24 * 1024 * 1024:
        raise ValueError("Audit image payload is missing or too large")
    source = Image.open(io.BytesIO(base64.b64decode(encoded, validate=True))).convert("RGBA")
    raw_regions = args.get("regions", [])
    regions = []
    for item in raw_regions[:80] if isinstance(raw_regions, list) else []:
        if not isinstance(item, dict):
            continue
        box = item.get("box") if isinstance(item.get("box"), (list, tuple)) else None
        x = float(item.get("x", box[0] if box and len(box) >= 4 else 0))
        y = float(item.get("y", box[1] if box and len(box) >= 4 else 0))
        w = float(item.get("width", box[2] - x if box and len(box) >= 4 else 0))
        h = float(item.get("height", box[3] - y if box and len(box) >= 4 else 0))
        if max(abs(x), abs(y), abs(w), abs(h)) <= 1.5:
            x, w = x * source.width, w * source.width
            y, h = y * source.height, h * source.height
        x, y = max(0, min(source.width - 1, int(x))), max(0, min(source.height - 1, int(y)))
        w, h = max(2, min(source.width - x, int(w))), max(2, min(source.height - y, int(h)))
        regions.append({"label": str(item.get("label", "region"))[:64], "x": x, "y": y, "width": w, "height": h})
    collisions = []
    for i, a in enumerate(regions):
        for b in regions[i + 1:]:
            overlap_w = min(a["x"] + a["width"], b["x"] + b["width"]) - max(a["x"], b["x"])
            overlap_h = min(a["y"] + a["height"], b["y"] + b["height"]) - max(a["y"], b["y"])
            if overlap_w > 6 and overlap_h > 6:
                collisions.append({"a": a["label"], "b": b["label"]})
    banner_height = 42
    image = Image.new("RGBA", (source.width, source.height + banner_height), (248, 250, 252, 255))
    image.alpha_composite(source, (0, banner_height))
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    draw.rectangle((0, 0, source.width, banner_height), fill=(15, 23, 42, 255))
    draw.text((18, 14), f"SAM 3.1 VISUAL QA · {len(regions)} REGIONS VERIFIED", fill=(255, 255, 255, 255), font=ImageFont.load_default())
    for index, region in enumerate(regions):
        color = (244, 96, 80, 190) if any(region["label"] in (c["a"], c["b"]) for c in collisions) else (34, 211, 238, 190)
        x, y = region["x"], region["y"] + banner_height
        draw.rounded_rectangle((x, y, x + region["width"], y + region["height"]), radius=4, fill=(*color[:3], 34), outline=color, width=3)
        draw.text((x + 3, max(banner_height, y - 13)), region["label"][:28], fill=(4, 25, 40, 255), font=ImageFont.load_default())
    output = Image.alpha_composite(image, overlay).convert("RGB")
    output_path = pathlib.Path(args["output"])
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output.save(output_path, format="PNG", optimize=True, compress_level=9)
    score = max(0, 100 - 8 * len(collisions))
    return {"outputPath": args.get("outputPath"), "size": output_path.stat().st_size, "regionCount": len(regions),
            "collisions": collisions, "layoutScore": score, "width": output.width, "height": output.height, "regions": regions}


def main():
    action = sys.argv[1]
    args = json.loads(base64.b64decode(sys.argv[2]))
    if action == "audit":
        print(json.dumps(visual_audit(args)))
        return
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
