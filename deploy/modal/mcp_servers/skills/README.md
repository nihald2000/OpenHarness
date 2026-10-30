# In-Sandbox Document & Office Skills

This module provides high-fidelity generation and conversion of enterprise documents directly within the Modal sandbox:
- Excel spreadsheets (`.xlsx`) via OpenPyXL
- Word documents (`.docx`) via python-docx
- PowerPoint presentations (`.pptx`) via python-pptx
- Charts & plots (`.png`) via Matplotlib
- PDF conversion via Pandoc & LibreOffice headless

## Usage Example

```python
from mcp_servers.skills import generate_excel, generate_chart, convert_to_pdf

generate_excel(
    headers=["Metric", "Q1", "Q2", "Q3", "Q4"],
    rows=[
        ["Revenue ($M)", 12.4, 14.8, 18.2, 22.5],
        ["Net Margin", "22%", "24%", "26%", "28%"]
    ],
    output_path="/mnt/data/financials.xlsx"
)
```
