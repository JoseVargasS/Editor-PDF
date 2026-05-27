from __future__ import annotations

import base64
import hashlib
import math
import statistics
import uuid
from pathlib import Path
from typing import Any, Literal

import fitz
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field


ROOT = Path(__file__).resolve().parent.parent
STORAGE = ROOT / ".pdf_editor_storage"
DIST = ROOT / "dist"
STORAGE.mkdir(exist_ok=True)

app = FastAPI(title="Editor PDF API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_origin_regex=r"^http://(127\.0\.0\.1|localhost):\d+$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class RectModel(BaseModel):
    x0: float
    y0: float
    x1: float
    y1: float


class PointModel(BaseModel):
    x: float
    y: float


class EditOperation(BaseModel):
    id: str
    type: Literal[
        "replace_text",
        "delete_text",
        "add_text",
        "rectangle",
        "highlight",
        "redact_area",
        "add_image",
        "move_image",
        "delete_image",
    ]
    pageIndex: int
    rect: RectModel
    originalRect: RectModel | None = None
    spanId: str | None = None
    objectId: str | None = None
    text: str | None = None
    fontFamily: str | None = None
    fontSize: float | None = None
    fontFlags: int | None = None
    fontXref: int | None = None
    fontResource: str | None = None
    fontInkDensity: float | None = None
    color: str | None = None
    fill: str | None = None
    opacity: float | None = Field(default=None, ge=0, le=1)
    strokeWidth: float | None = None
    imageData: str | None = None
    imageXref: int | None = None
    origin: PointModel | None = None


class ExportRequest(BaseModel):
    operations: list[EditOperation] = Field(default_factory=list)
    pageIndexes: list[int] | None = None


def document_dir(document_id: str) -> Path:
    return STORAGE / document_id


def original_path(document_id: str) -> Path:
    return document_dir(document_id) / "original.pdf"


def output_path(document_id: str) -> Path:
    return document_dir(document_id) / "edited.pdf"


def as_rect(rect: RectModel | dict[str, Any]) -> fitz.Rect:
    if isinstance(rect, RectModel):
        return fitz.Rect(rect.x0, rect.y0, rect.x1, rect.y1)
    return fitz.Rect(rect["x0"], rect["y0"], rect["x1"], rect["y1"])


def normalize_rect(rect: fitz.Rect, page_rect: fitz.Rect | None = None) -> fitz.Rect:
    fixed = fitz.Rect(min(rect.x0, rect.x1), min(rect.y0, rect.y1), max(rect.x0, rect.x1), max(rect.y0, rect.y1))
    if page_rect is not None:
        fixed = fixed & page_rect
    if fixed.width < 0.5:
        fixed.x1 = fixed.x0 + 0.5
    if fixed.height < 0.5:
        fixed.y1 = fixed.y0 + 0.5
    return fixed


def color_int_to_hex(value: int | None) -> str:
    if value is None:
        return "#000000"
    return f"#{value & 0xFFFFFF:06x}"


def rgb_tuple_to_hex(value: Any) -> str | None:
    if not value:
        return None
    try:
        channels = [max(0, min(255, round(float(c) * 255))) for c in value[:3]]
        return f"#{channels[0]:02x}{channels[1]:02x}{channels[2]:02x}"
    except Exception:
        return None


def hex_to_rgb(value: str | None, fallback: tuple[float, float, float] = (0, 0, 0)) -> tuple[float, float, float]:
    if not value:
        return fallback
    cleaned = value.strip().lstrip("#")
    if len(cleaned) == 3:
        cleaned = "".join(ch * 2 for ch in cleaned)
    if len(cleaned) != 6:
        return fallback
    try:
        return (
            int(cleaned[0:2], 16) / 255,
            int(cleaned[2:4], 16) / 255,
            int(cleaned[4:6], 16) / 255,
        )
    except ValueError:
        return fallback


def clean_font_name(name: str | None) -> str:
    if not name:
        return "Helvetica"
    if "+" in name and len(name.split("+", 1)[0]) <= 8:
        name = name.split("+", 1)[1]
    return name.replace(",", " ").strip() or "Helvetica"


def norm_font_key(name: str | None) -> str:
    return "".join(ch for ch in clean_font_name(name).lower() if ch.isalnum())


def windows_font_candidates(family: str, bold: bool, italic: bool) -> list[Path]:
    fonts_dir = Path("C:/Windows/Fonts")
    key = norm_font_key(family)
    stems: list[str] = []
    if "calibri" in key:
        stems = ["calibriz" if bold and italic else "calibrib" if bold else "calibrii" if italic else "calibri"]
    elif "arial" in key or "helvetica" in key:
        stems = ["arialbi" if bold and italic else "arialbd" if bold else "ariali" if italic else "arial"]
    elif "times" in key or "roman" in key:
        stems = ["timesbi" if bold and italic else "timesbd" if bold else "timesi" if italic else "times"]
    elif "courier" in key:
        stems = ["courbi" if bold and italic else "courbd" if bold else "couri" if italic else "cour"]
    elif "cambria" in key:
        stems = ["cambriaz" if bold and italic else "cambriab" if bold else "cambriai" if italic else "cambria"]
    elif "segoe" in key:
        stems = ["segoeuiz" if bold and italic else "segoeuib" if bold else "segoeuii" if italic else "segoeui"]

    result: list[Path] = []
    for stem in stems:
        for ext in ("ttf", "otf", "ttc"):
            candidate = fonts_dir / f"{stem}.{ext}"
            if candidate.exists():
                result.append(candidate)
    return result


def resolve_font(family: str | None, flags: int = 0) -> tuple[str, str | None]:
    clean = clean_font_name(family)
    key = norm_font_key(clean)
    bold = bool(flags & 16) or "bold" in key or "black" in key or key.endswith("bd")
    italic = bool(flags & 2) or "italic" in key or "oblique" in key or key.endswith("it")

    candidates = windows_font_candidates(clean, bold, italic)
    if candidates:
        stable_name = f"F{hashlib.sha1(str(candidates[0]).encode()).hexdigest()[:8]}"
        return stable_name, str(candidates[0])

    if "courier" in key:
        if bold and italic:
            return "cobi", None
        if bold:
            return "cob", None
        if italic:
            return "coit", None
        return "cour", None
    if "times" in key or "roman" in key or "serif" in key:
        if bold and italic:
            return "tibi", None
        if bold:
            return "tibo", None
        if italic:
            return "tiit", None
        return "tiro", None
    if bold and italic:
        return "hebi", None
    if bold:
        return "hebo", None
    if italic:
        return "heit", None
    return "helv", None


def font_lookup_key(name: str | None) -> str:
    key = norm_font_key(name)
    for token in ("regular", "normal", "ps", "mt", "std"):
        key = key.replace(token, "")
    return key


def page_font_lookup(page: fitz.Page) -> dict[str, dict[str, Any]]:
    lookup: dict[str, dict[str, Any]] = {}
    for font in page.get_fonts(full=True):
        xref, ext, font_type, basefont, resource_name, encoding = font[:6]
        info = {
            "xref": int(xref),
            "ext": ext,
            "type": font_type,
            "basefont": clean_font_name(basefont),
            "resource": resource_name,
            "encoding": encoding,
        }
        for name in (basefont, resource_name, clean_font_name(basefont)):
            key = font_lookup_key(name)
            if key:
                lookup.setdefault(key, info)
    return lookup


def match_font_info(span_font: str | None, lookup: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
    key = font_lookup_key(span_font)
    if key in lookup:
        return lookup[key]
    for candidate_key, info in lookup.items():
        if key and (key in candidate_key or candidate_key in key):
            return info
    return None


def span_ink_density(page: fitz.Page, rect: fitz.Rect) -> float:
    clip = normalize_rect(rect + (-0.5, -0.5, 0.5, 0.5), page.rect)
    if clip.is_empty:
        return 0.0
    try:
        pix = page.get_pixmap(matrix=fitz.Matrix(2, 2), colorspace=fitz.csGRAY, alpha=False, clip=clip)
    except Exception:
        return 0.0
    samples = pix.samples
    if not samples:
        return 0.0
    mean_darkness = sum(255 - value for value in samples) / (255 * len(samples))
    dark_ratio = sum(1 for value in samples if value < 180) / len(samples)
    return round(max(mean_darkness, dark_ratio * 0.5), 4)


def make_ink_density_sampler(page: fitz.Page, scale: float = 2.0):
    try:
        pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), colorspace=fitz.csGRAY, alpha=False)
    except Exception:
        return lambda rect: span_ink_density(page, rect)

    samples = memoryview(pix.samples)
    page_rect = page.rect
    stride = pix.stride

    def sample(rect: fitz.Rect) -> float:
        clip = normalize_rect(rect + (-0.5, -0.5, 0.5, 0.5), page_rect)
        if clip.is_empty:
            return 0.0

        x0 = max(0, min(pix.width, math.floor((clip.x0 - page_rect.x0) * scale)))
        y0 = max(0, min(pix.height, math.floor((clip.y0 - page_rect.y0) * scale)))
        x1 = max(x0 + 1, min(pix.width, math.ceil((clip.x1 - page_rect.x0) * scale)))
        y1 = max(y0 + 1, min(pix.height, math.ceil((clip.y1 - page_rect.y0) * scale)))

        total = 0
        darkness = 0
        dark_pixels = 0
        for y in range(y0, y1):
            start = y * stride + x0
            row = samples[start : y * stride + x1]
            for value in row:
                darkness += 255 - value
                if value < 180:
                    dark_pixels += 1
                total += 1
        if not total:
            return 0.0
        mean_darkness = darkness / (255 * total)
        dark_ratio = dark_pixels / total
        return round(max(mean_darkness, dark_ratio * 0.5), 4)

    return sample


def extracted_font_path(doc: fitz.Document, xref: int | None, document_id: str | None = None) -> str | None:
    if not xref or not document_id:
        return None
    try:
        name, ext, _font_type, content = doc.extract_font(int(xref))
    except Exception:
        return None
    if not content or ext in {"n/a", ""}:
        return None
    safe_ext = "ttf" if ext.lower() in {"ttf", "truetype"} else ext.lower().lstrip(".")
    safe_name = "".join(ch for ch in clean_font_name(name) if ch.isalnum() or ch in {"-", "_"})[:64] or "font"
    folder = document_dir(document_id) / "fonts"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{int(xref)}-{safe_name}.{safe_ext}"
    if not path.exists():
        path.write_bytes(content)
    return str(path)


def clone_document(doc: fitz.Document) -> fitz.Document | None:
    try:
        return fitz.open(stream=doc.tobytes(garbage=0, deflate=True), filetype="pdf")
    except Exception:
        return None


def rect_to_payload(rect: Any) -> dict[str, float]:
    r = fitz.Rect(rect)
    return {"x0": round(r.x0, 3), "y0": round(r.y0, 3), "x1": round(r.x1, 3), "y1": round(r.y1, 3)}


def stable_id(*parts: Any) -> str:
    digest = hashlib.sha1("|".join(str(part) for part in parts).encode("utf-8", "ignore")).hexdigest()[:12]
    return digest


def extract_document(document_id: str, path: Path) -> dict[str, Any]:
    doc = fitz.open(path)
    pages: list[dict[str, Any]] = []
    for page_index, page in enumerate(doc):
        page_payload: dict[str, Any] = {
            "index": page_index,
            "width": round(page.rect.width, 3),
            "height": round(page.rect.height, 3),
            "rotation": page.rotation,
            "text": [],
            "images": [],
            "drawings": [],
        }
        fonts_by_name = page_font_lookup(page)
        ink_density = make_ink_density_sampler(page)

        text = page.get_text("dict")
        for block_index, block in enumerate(text.get("blocks", [])):
            if block.get("type") != 0:
                continue
            for line_index, line in enumerate(block.get("lines", [])):
                for span_index, span in enumerate(line.get("spans", [])):
                    content = span.get("text", "")
                    if not content or not content.strip():
                        continue
                    bbox = fitz.Rect(span.get("bbox"))
                    if bbox.is_empty or bbox.width < 0.1 or bbox.height < 0.1:
                        continue
                    origin = span.get("origin", [bbox.x0, bbox.y1])
                    font_info = match_font_info(span.get("font"), fonts_by_name)
                    span_id = f"p{page_index}-t{stable_id(block_index, line_index, span_index, content, bbox)}"
                    page_payload["text"].append(
                        {
                            "id": span_id,
                            "text": content,
                            "rect": rect_to_payload(bbox),
                            "origin": {"x": round(float(origin[0]), 3), "y": round(float(origin[1]), 3)},
                            "fontFamily": clean_font_name(span.get("font")),
                            "fontSize": round(float(span.get("size", 11)), 3),
                            "fontXref": font_info.get("xref") if font_info else None,
                            "fontResource": font_info.get("resource") if font_info else None,
                            "fontType": font_info.get("type") if font_info else None,
                            "fontInkDensity": ink_density(bbox),
                            "color": color_int_to_hex(span.get("color")),
                            "flags": int(span.get("flags", 0)),
                            "ascender": span.get("ascender"),
                            "descender": span.get("descender"),
                            "lineDir": line.get("dir", [1, 0]),
                        }
                    )

        try:
            for image_index, image in enumerate(page.get_image_info(xrefs=True)):
                bbox = image.get("bbox")
                if not bbox:
                    continue
                rect = fitz.Rect(bbox)
                if rect.is_empty or rect.width < 2 or rect.height < 2:
                    continue
                xref = int(image.get("xref", 0) or 0)
                page_payload["images"].append(
                    {
                        "id": f"p{page_index}-img{image_index}-x{xref}-{stable_id(rect)}",
                        "rect": rect_to_payload(rect),
                        "xref": xref,
                        "width": image.get("width"),
                        "height": image.get("height"),
                        "colorspace": image.get("cs-name") or image.get("colorspace"),
                    }
                )
        except Exception:
            page_payload["images"] = []

        try:
            for drawing_index, drawing in enumerate(page.get_drawings()):
                rect = drawing.get("rect")
                if not rect:
                    continue
                r = fitz.Rect(rect)
                if r.is_empty or r.width < 2 or r.height < 2:
                    continue
                page_payload["drawings"].append(
                    {
                        "id": f"p{page_index}-draw{drawing_index}-{stable_id(r)}",
                        "rect": rect_to_payload(r),
                        "stroke": rgb_tuple_to_hex(drawing.get("color")),
                        "fill": rgb_tuple_to_hex(drawing.get("fill")),
                        "width": drawing.get("width"),
                        "type": drawing.get("type"),
                    }
                )
        except Exception:
            page_payload["drawings"] = []

        pages.append(page_payload)

    payload = {
        "id": document_id,
        "filename": path.name,
        "pageCount": doc.page_count,
        "pages": pages,
    }
    doc.close()
    return payload


def sample_background(page: fitz.Page, rect: fitz.Rect) -> tuple[float, float, float]:
    page_rect = page.rect
    clip = normalize_rect(rect + (-2, -2, 2, 2), page_rect)
    if clip.is_empty:
        return (1, 1, 1)
    try:
        pix = page.get_pixmap(matrix=fitz.Matrix(1, 1), colorspace=fitz.csRGB, alpha=False, clip=clip)
        samples = pix.samples
        if not samples:
            return (1, 1, 1)
        values: list[tuple[int, int, int]] = []
        step_x = max(1, pix.width // 10)
        step_y = max(1, pix.height // 10)
        for y in range(0, pix.height, step_y):
            for x in range(0, pix.width, step_x):
                offset = (y * pix.width + x) * pix.n
                values.append((samples[offset], samples[offset + 1], samples[offset + 2]))
        if not values:
            return (1, 1, 1)
        return (
            statistics.median(v[0] for v in values) / 255,
            statistics.median(v[1] for v in values) / 255,
            statistics.median(v[2] for v in values) / 255,
        )
    except Exception:
        return (1, 1, 1)


def decode_data_url(data_url: str) -> bytes:
    if "," in data_url and data_url.split(",", 1)[0].startswith("data:"):
        data_url = data_url.split(",", 1)[1]
    return base64.b64decode(data_url)


def add_redaction(
    page: fitz.Page,
    rect: fitz.Rect,
    fill: tuple[float, float, float] | None,
    cross_out: bool = False,
) -> None:
    rect = normalize_rect(rect, page.rect)
    if not rect.is_empty:
        page.add_redact_annot(rect, fill=fill, cross_out=cross_out)


def insert_text_operation(
    doc: fitz.Document,
    page: fitz.Page,
    op: EditOperation,
    rect: fitz.Rect,
    document_id: str | None = None,
) -> None:
    text = op.text or ""
    if not text:
        return
    font_size = float(op.fontSize or max(8, rect.height * 0.72))
    flags = int(op.fontFlags or 0)
    font_file: str | None = None
    if op.fontResource:
        font_name = op.fontResource
    else:
        font_file = extracted_font_path(doc, op.fontXref, document_id)
        if font_file:
            font_name = f"F{hashlib.sha1(font_file.encode()).hexdigest()[:8]}"
        else:
            font_name, font_file = resolve_font(op.fontFamily, flags)
    color = hex_to_rgb(op.color, (0, 0, 0))
    if font_file:
        font_name = f"F{hashlib.sha1(font_file.encode()).hexdigest()[:8]}"
    kwargs: dict[str, Any] = {
        "fontsize": font_size,
        "fontname": font_name,
        "fontfile": font_file,
        "color": color,
        "fill": color,
        "overlay": True,
    }
    if font_file is None:
        kwargs.pop("fontfile")

    def stroke_variant(current_kwargs: dict[str, Any], stroke_width: float) -> dict[str, Any]:
        variant = dict(current_kwargs)
        variant.pop("render_mode", None)
        variant.pop("border_width", None)
        variant.pop("stroke_opacity", None)
        if stroke_width > 0:
            variant["render_mode"] = 2
            variant["border_width"] = stroke_width
            variant["stroke_opacity"] = 1
        return variant

    def place(target_page: fitz.Page, current_kwargs: dict[str, Any]) -> None:
        if op.origin and "\n" not in text:
            point = fitz.Point(op.origin.x, op.origin.y)
            target_page.insert_text(point, text, **current_kwargs)
            return
        target_page.insert_textbox(rect, text, align=0, **current_kwargs)

    def candidate_density(current_kwargs: dict[str, Any]) -> float | None:
        clone = clone_document(doc)
        if clone is None:
            return None
        try:
            clone_page = clone[page.number]
            place(clone_page, current_kwargs)
            spans: list[dict[str, Any]] = []
            for block in clone_page.get_text("dict").get("blocks", []):
                for line in block.get("lines", []):
                    spans.extend(line.get("spans", []))
            matches = [span for span in spans if span.get("text") == text]
            if not matches:
                matches = [span for span in spans if text and text in span.get("text", "")]
            if not matches:
                return None
            return span_ink_density(clone_page, fitz.Rect(matches[-1].get("bbox")))
        except Exception:
            return None
        finally:
            clone.close()

    def visually_matched_kwargs(base_kwargs: dict[str, Any]) -> dict[str, Any]:
        target_density = float(op.fontInkDensity or 0)
        if target_density <= 0:
            return base_kwargs
        key = norm_font_key(op.fontFamily)
        boldish = bool(flags & 16) or "bold" in key or "black" in key or "heavy" in key or key.endswith("bd")
        target_density = min(target_density, 0.42 if boldish else 0.34)
        best_kwargs = base_kwargs
        best_score: float | None = None
        stroke_widths = (
            0.0,
            0.005,
            0.01,
            0.015,
            0.02,
            0.025,
            0.03,
            0.035,
            0.04,
            0.045,
            0.05,
            0.055,
            0.06,
            0.065,
            0.07,
            0.08,
            0.09,
            0.1,
            0.12,
            0.14,
            0.17,
            0.2,
        )
        for stroke_width in stroke_widths:
            candidate = stroke_variant(base_kwargs, stroke_width)
            density = candidate_density(candidate)
            if density is None:
                continue
            overshoot_penalty = 1.25 if density > target_density else 1.0
            score = abs(density - target_density) * overshoot_penalty + stroke_width * 0.05
            if best_score is None or score < best_score:
                best_score = score
                best_kwargs = candidate
            if density > target_density + 0.055:
                break
        return best_kwargs

    kwargs = visually_matched_kwargs(kwargs)

    if op.origin and "\n" not in text:
        try:
            place(page, kwargs)
        except Exception:
            fallback_name, fallback_file = resolve_font(op.fontFamily, flags)
            fallback = {**kwargs, "fontname": fallback_name, "fontfile": fallback_file}
            if fallback_file is None:
                fallback.pop("fontfile", None)
            place(page, visually_matched_kwargs(fallback))
        return

    try:
        place(page, kwargs)
    except Exception:
        fallback_name, fallback_file = resolve_font(op.fontFamily, flags)
        fallback = {**kwargs, "fontname": fallback_name, "fontfile": fallback_file}
        if fallback_file is None:
            fallback.pop("fontfile", None)
        place(page, visually_matched_kwargs(fallback))


def draw_shape_operation(page: fitz.Page, op: EditOperation, rect: fitz.Rect) -> None:
    stroke = hex_to_rgb(op.color, (0.06, 0.25, 0.65))
    fill = hex_to_rgb(op.fill, stroke)
    width = float(op.strokeWidth or 1.2)
    opacity = float(op.opacity if op.opacity is not None else 1)

    if op.type == "highlight":
        page.draw_rect(rect, color=fill, fill=fill, width=0, fill_opacity=max(0.1, min(opacity, 0.45)), overlay=True)
        return
    page.draw_rect(rect, color=stroke, fill=fill if op.fill else None, width=width, fill_opacity=opacity, overlay=True)


def extract_original_image(doc: fitz.Document, xref: int | None) -> bytes | None:
    if not xref:
        return None
    try:
        image = doc.extract_image(int(xref))
        return image.get("image")
    except Exception:
        return None


def apply_operations_to_document(
    doc: fitz.Document,
    operations: list[EditOperation],
    document_id: str | None = None,
) -> None:
    ops_by_page: dict[int, list[EditOperation]] = {}
    for op in operations:
        if 0 <= op.pageIndex < doc.page_count:
            ops_by_page.setdefault(op.pageIndex, []).append(op)

    for page_index, page_operations in ops_by_page.items():
        page = doc[page_index]

        for op in page_operations:
            rect = normalize_rect(as_rect(op.originalRect or op.rect), page.rect)
            if op.type in {"replace_text", "delete_text"}:
                add_redaction(page, rect, fill=None)
            elif op.type in {"move_image", "delete_image"}:
                fill = sample_background(page, rect)
                add_redaction(page, rect, fill=fill)
            elif op.type == "redact_area":
                fill = hex_to_rgb(op.fill or "#111111", (0, 0, 0))
                add_redaction(page, normalize_rect(as_rect(op.rect), page.rect), fill=fill)

        if any(op.type in {"replace_text", "delete_text", "move_image", "delete_image", "redact_area"} for op in page_operations):
            page.apply_redactions(
                images=fitz.PDF_REDACT_IMAGE_PIXELS,
                graphics=fitz.PDF_REDACT_LINE_ART_NONE,
                text=fitz.PDF_REDACT_TEXT_REMOVE,
            )

        for op in page_operations:
            rect = normalize_rect(as_rect(op.rect), page.rect)
            if op.type in {"replace_text", "add_text"}:
                insert_text_operation(doc, page, op, rect, document_id)
            elif op.type in {"rectangle", "highlight"}:
                draw_shape_operation(page, op, rect)
            elif op.type == "add_image":
                if op.imageData:
                    page.insert_image(rect, stream=decode_data_url(op.imageData), keep_proportion=True, overlay=True)
            elif op.type == "move_image":
                stream = extract_original_image(doc, op.imageXref)
                if stream:
                    page.insert_image(rect, stream=stream, keep_proportion=True, overlay=True)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/documents")
async def upload_document(file: UploadFile = File(...)) -> dict[str, Any]:
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Archivo vacio")
    try:
        doc = fitz.open(stream=data, filetype="pdf")
    except Exception as exc:
        raise HTTPException(status_code=400, detail="No se pudo abrir el PDF") from exc
    if doc.needs_pass:
        doc.close()
        raise HTTPException(status_code=400, detail="PDF protegido con contrasena")

    document_id = uuid.uuid4().hex
    folder = document_dir(document_id)
    folder.mkdir(parents=True, exist_ok=True)
    path = original_path(document_id)
    path.write_bytes(data)
    doc.close()

    payload = extract_document(document_id, path)
    payload["filename"] = file.filename or "documento.pdf"
    return payload


@app.get("/api/documents/{document_id}")
def get_document(document_id: str) -> dict[str, Any]:
    path = original_path(document_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Documento no encontrado")
    return extract_document(document_id, path)


@app.get("/api/documents/{document_id}/pages/{page_index}/image")
def render_page(document_id: str, page_index: int, scale: float = 2.0) -> Response:
    path = original_path(document_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Documento no encontrado")
    doc = fitz.open(path)
    try:
        if page_index < 0 or page_index >= doc.page_count:
            raise HTTPException(status_code=404, detail="Pagina no encontrada")
        page = doc[page_index]
        scale = max(0.5, min(float(scale), 4.0))
        pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
        return Response(pix.tobytes("png"), media_type="image/png")
    finally:
        doc.close()


@app.post("/api/documents/{document_id}/pages/{page_index}/preview")
def render_page_preview(document_id: str, page_index: int, request: ExportRequest, scale: float = 2.0) -> Response:
    path = original_path(document_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Documento no encontrado")
    doc = fitz.open(path)
    try:
        if page_index < 0 or page_index >= doc.page_count:
            raise HTTPException(status_code=404, detail="Pagina no encontrada")
        apply_operations_to_document(doc, request.operations, document_id)
        page = doc[page_index]
        scale = max(0.5, min(float(scale), 4.0))
        pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
        return Response(pix.tobytes("png"), media_type="image/png")
    finally:
        doc.close()


@app.post("/api/documents/{document_id}/export")
def export_document(document_id: str, request: ExportRequest) -> FileResponse:
    path = original_path(document_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Documento no encontrado")

    doc = fitz.open(path)
    try:
        apply_operations_to_document(doc, request.operations, document_id)
        if request.pageIndexes:
            valid_pages = sorted({index for index in request.pageIndexes if 0 <= index < doc.page_count})
            if not valid_pages:
                raise HTTPException(status_code=400, detail="Selecciona al menos una pagina valida")
            doc.select(valid_pages)
        out = output_path(document_id)
        doc.save(out, garbage=4, deflate=True, clean=True)
    finally:
        doc.close()

    return FileResponse(output_path(document_id), media_type="application/pdf", filename=f"editado-{document_id[:8]}.pdf")


if (DIST / "assets").exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")


@app.get("/{full_path:path}", include_in_schema=False)
def serve_frontend(full_path: str) -> FileResponse:
    if full_path.startswith("api/"):
        raise HTTPException(status_code=404, detail="Ruta API no encontrada")
    requested = (DIST / full_path).resolve() if full_path else DIST / "index.html"
    if full_path and requested.is_file() and requested.is_relative_to(DIST.resolve()):
        return FileResponse(requested)
    index = DIST / "index.html"
    if index.exists():
        return FileResponse(index)
    raise HTTPException(status_code=404, detail="Frontend no compilado. Ejecuta npm run build.")
