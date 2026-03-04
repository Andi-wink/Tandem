"""
F044: Document parsing service for the AI context basket.

Extracts text from PDF, DOCX, TXT, MD, and CSV files so they can be
added to the AI panel's context basket alongside transcripts and screenshots.
"""

import logging
from io import BytesIO
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# Maximum characters to include (prevents blowing the context window)
MAX_CONTENT_CHARS = 50_000
PREVIEW_CHARS = 200


def _truncation_notice(total_pages: int, included_pages: int) -> str:
    return (
        f"\n\n[Document truncated — showing first {included_pages} of "
        f"{total_pages} pages. Ask about specific sections for more detail.]"
    )


async def parse_document(
    file_bytes: bytes,
    filename: str,
) -> dict:
    """Parse a document and return extracted text with metadata.

    Returns:
        {
            "filename": str,
            "format": str,        # "PDF", "DOCX", "TXT", "Markdown", "CSV"
            "pages": int | None,  # page count for PDFs, None for others
            "text": str,          # full extracted text (may be truncated)
            "preview": str,       # first ~200 chars
            "truncated": bool,
        }
    """
    ext = Path(filename).suffix.lower()

    if ext == ".pdf":
        return _parse_pdf(file_bytes, filename)
    elif ext == ".docx":
        return _parse_docx(file_bytes, filename)
    elif ext == ".csv":
        return _parse_csv(file_bytes, filename)
    elif ext in (".txt", ".md", ".markdown"):
        return _parse_text(file_bytes, filename, ext)
    else:
        raise ValueError(f"Unsupported file type: {ext}")


def _parse_pdf(data: bytes, filename: str) -> dict:
    import fitz  # PyMuPDF

    doc = fitz.open(stream=data, filetype="pdf")
    pages = len(doc)
    parts: list[str] = []
    char_count = 0
    included = 0

    for i, page in enumerate(doc):
        page_text = page.get_text().strip()
        header = f"[Page {i + 1}/{pages}]"
        segment = f"{header}\n{page_text}"

        if char_count + len(segment) > MAX_CONTENT_CHARS and included > 0:
            break
        parts.append(segment)
        char_count += len(segment)
        included += 1

    doc.close()
    text = "\n\n".join(parts)
    truncated = included < pages
    if truncated:
        text += _truncation_notice(pages, included)

    preview = text[:PREVIEW_CHARS].replace("\n", " ").strip()
    return {
        "filename": filename,
        "format": "PDF",
        "pages": pages,
        "text": text,
        "preview": preview,
        "truncated": truncated,
    }


def _parse_docx(data: bytes, filename: str) -> dict:
    from docx import Document

    doc = Document(BytesIO(data))
    parts: list[str] = []

    for para in doc.paragraphs:
        text = para.text.strip()
        if not text:
            continue
        # Preserve heading hierarchy
        if para.style and para.style.name.startswith("Heading"):
            level = para.style.name.replace("Heading", "").strip()
            prefix = "#" * int(level) if level.isdigit() else "##"
            parts.append(f"{prefix} {text}")
        else:
            parts.append(text)

    text = "\n\n".join(parts)
    truncated = len(text) > MAX_CONTENT_CHARS
    if truncated:
        text = text[:MAX_CONTENT_CHARS] + "\n\n[Document truncated.]"

    preview = text[:PREVIEW_CHARS].replace("\n", " ").strip()
    return {
        "filename": filename,
        "format": "DOCX",
        "pages": None,
        "text": text,
        "preview": preview,
        "truncated": truncated,
    }


def _parse_csv(data: bytes, filename: str) -> dict:
    import pandas as pd

    df = pd.read_csv(BytesIO(data))
    text = df.to_markdown(index=False)
    truncated = len(text) > MAX_CONTENT_CHARS
    if truncated:
        # Show header + first N rows that fit
        text = text[:MAX_CONTENT_CHARS] + "\n\n[Table truncated.]"

    preview = f"{len(df)} rows x {len(df.columns)} columns: {', '.join(df.columns[:5])}"
    return {
        "filename": filename,
        "format": "CSV",
        "pages": None,
        "text": text,
        "preview": preview,
        "truncated": truncated,
    }


def _parse_text(data: bytes, filename: str, ext: str) -> dict:
    text = data.decode("utf-8", errors="replace")
    fmt = "Markdown" if ext in (".md", ".markdown") else "TXT"
    truncated = len(text) > MAX_CONTENT_CHARS
    if truncated:
        text = text[:MAX_CONTENT_CHARS] + "\n\n[Document truncated.]"

    preview = text[:PREVIEW_CHARS].replace("\n", " ").strip()
    return {
        "filename": filename,
        "format": fmt,
        "pages": None,
        "text": text,
        "preview": preview,
        "truncated": truncated,
    }


def supported_extensions() -> list[str]:
    """Return list of supported file extensions."""
    return [".pdf", ".docx", ".txt", ".md", ".markdown", ".csv"]