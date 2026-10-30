"""Office, Document & Data Visualization Skills for Code-Mode Execution."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional


def generate_excel(
    headers: List[str],
    rows: List[List[Any]],
    output_path: str = "/mnt/data/report.xlsx",
    sheet_title: str = "Summary",
) -> Dict[str, Any]:
    """Generates a styled Excel spreadsheet using OpenPyXL."""
    import openpyxl
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = sheet_title

    # Header style
    header_font = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
    header_fill = PatternFill(start_color="1F497D", end_color="1F497D", fill_type="solid")
    center_align = Alignment(horizontal="center", vertical="center")
    thin_border = Border(
        left=Side(style="thin", color="D9D9D9"),
        right=Side(style="thin", color="D9D9D9"),
        top=Side(style="thin", color="D9D9D9"),
        bottom=Side(style="thin", color="D9D9D9"),
    )

    # Write headers
    for col_idx, h in enumerate(headers, start=1):
        cell = ws.cell(row=1, column=col_idx, value=h)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = center_align

    # Write rows
    for row_idx, row_data in enumerate(rows, start=2):
        for col_idx, val in enumerate(row_data, start=1):
            cell = ws.cell(row=row_idx, column=col_idx, value=val)
            cell.border = thin_border
            if isinstance(val, (int, float)):
                cell.alignment = Alignment(horizontal="right")

    # Auto-adjust column widths
    for col in ws.columns:
        max_len = max(len(str(cell.value or "")) for cell in col)
        col_letter = openpyxl.utils.get_column_letter(col[0].column)
        ws.column_dimensions[col_letter].width = max(max_len + 4, 12)

    target = Path(output_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    wb.save(str(target))

    return {
        "path": str(target),
        "size_bytes": target.stat().st_size,
        "rows_count": len(rows),
        "ok": True,
    }


def generate_word(
    title: str,
    sections: List[Dict[str, Any]],
    output_path: str = "/mnt/data/document.docx",
) -> Dict[str, Any]:
    """Generates a Microsoft Word document (.docx) with headings, paragraphs, and tables."""
    import docx
    from docx.shared import Inches, Pt, RGBColor

    doc = docx.Document()
    title_p = doc.add_heading(title, level=0)

    for sec in sections:
        sec_title = sec.get("heading")
        if sec_title:
            doc.add_heading(sec_title, level=sec.get("level", 1))

        text = sec.get("text")
        if text:
            doc.add_paragraph(text)

        bullet_items = sec.get("bullets", [])
        for item in bullet_items:
            doc.add_paragraph(item, style="List Bullet")

        table_data = sec.get("table")
        if table_data and "headers" in table_data and "rows" in table_data:
            t = doc.add_table(rows=1, cols=len(table_data["headers"]))
            t.style = "Table Grid"
            hdr_cells = t.rows[0].cells
            for idx, h in enumerate(table_data["headers"]):
                hdr_cells[idx].text = str(h)
            for r in table_data["rows"]:
                row_cells = t.add_row().cells
                for idx, val in enumerate(r):
                    row_cells[idx].text = str(val)

    target = Path(output_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(target))

    return {
        "path": str(target),
        "size_bytes": target.stat().st_size,
        "sections_count": len(sections),
        "ok": True,
    }


def generate_powerpoint(
    title: str,
    subtitle: str,
    slides_data: List[Dict[str, Any]],
    output_path: str = "/mnt/data/presentation.pptx",
) -> Dict[str, Any]:
    """Generates a PowerPoint presentation (.pptx)."""
    import pptx
    from pptx.util import Inches, Pt

    prs = pptx.Presentation()

    # Title slide
    title_layout = prs.slide_layouts[0]
    slide = prs.slides.add_slide(title_layout)
    slide.shapes.title.text = title
    if slide.placeholders and len(slide.placeholders) > 1:
        slide.placeholders[1].text = subtitle

    # Content slides
    content_layout = prs.slide_layouts[1]
    for s_info in slides_data:
        s = prs.slides.add_slide(content_layout)
        s.shapes.title.text = s_info.get("title", "")
        body_shape = s.shapes.placeholders[1]
        tf = body_shape.text_frame
        points = s_info.get("points", [])
        if points:
            tf.text = points[0]
            for p in points[1:]:
                p_para = tf.add_paragraph()
                p_para.text = p

    target = Path(output_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    prs.save(str(target))

    return {
        "path": str(target),
        "size_bytes": target.stat().st_size,
        "slides_count": len(prs.slides),
        "ok": True,
    }


def generate_chart(
    data: Dict[str, Any],
    title: str,
    output_path: str = "/mnt/data/chart.png",
    chart_type: str = "bar",
) -> Dict[str, Any]:
    """Renders a chart using matplotlib with clean publication-ready styling."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(8, 4.5), dpi=200)

    labels = data.get("labels", [])
    values = data.get("values", [])

    if chart_type == "bar":
        ax.bar(labels, values, color="#2563EB", edgecolor="#1D4ED8", width=0.6)
    elif chart_type == "line":
        ax.plot(labels, values, marker="o", color="#2563EB", linewidth=2.5)
    elif chart_type == "scatter":
        ax.scatter(labels, values, color="#2563EB", s=60)
    elif chart_type == "pie":
        ax.pie(values, labels=labels, autopct="%1.1f%%", startangle=140)

    if chart_type != "pie":
        ax.set_ylabel(data.get("ylabel", ""))
        ax.set_xlabel(data.get("xlabel", ""))
        ax.grid(axis="y", linestyle="--", alpha=0.5)

    ax.set_title(title, fontsize=12, fontweight="bold", pad=12)
    plt.tight_layout()

    target = Path(output_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(str(target))
    plt.close(fig)

    return {
        "path": str(target),
        "size_bytes": target.stat().st_size,
        "ok": True,
    }


def convert_to_pdf(input_path: str, output_path: str = "/mnt/data/output.pdf") -> Dict[str, Any]:
    """Converts a document (Markdown, Docx, HTML) to PDF using Pandoc or LibreOffice."""
    in_file = Path(input_path)
    if not in_file.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")

    target = Path(output_path)
    target.parent.mkdir(parents=True, exist_ok=True)

    if in_file.suffix.lower() == ".md":
        cmd = ["pandoc", str(in_file), "-o", str(target), "--pdf-engine=weasyprint"]
        # Fallback if weasyprint not installed: use libreoffice or direct pandoc
        res = subprocess.run(["pandoc", str(in_file), "-o", str(target)], capture_output=True, text=True)
        if res.returncode != 0:
            # Fallback to wkhtmltopdf or libreoffice
            res2 = subprocess.run(["libreoffice", "--headless", "--convert-to", "pdf", str(in_file), "--outdir", str(target.parent)], capture_output=True)
            if res2.returncode != 0:
                raise RuntimeError(f"PDF conversion failed: {res.stderr}")
    else:
        res = subprocess.run(
            ["libreoffice", "--headless", "--convert-to", "pdf", str(in_file), "--outdir", str(target.parent)],
            capture_output=True,
            text=True,
        )
        if res.returncode != 0:
            raise RuntimeError(f"LibreOffice conversion failed: {res.stderr}")

    return {
        "path": str(target),
        "size_bytes": target.stat().st_size if target.exists() else 0,
        "ok": True,
    }
