#!/usr/bin/env python3
"""Build the QM Prayag static site.

Reads every quiz file in quizzes/ (PDF, PPTX, PPT, ODP, DOCX ...), converts
non-PDF files to PDF with LibreOffice, extracts the slide text and a cover
thumbnail, and writes a fully static, search-engine-friendly site to _site/.

Usage:
    python build.py                 # build into _site/
    python build.py --serve         # build, then preview on http://localhost:8000
"""

from __future__ import annotations

import argparse
import datetime as dt
import email.utils
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import quote, urlsplit

import jinja2
import markdown
import pymupdf
import yaml

import media as av

pymupdf.TOOLS.mupdf_display_errors(False)  # e.g. harmless notes about video "Screen" annotations

ROOT = Path(__file__).resolve().parent
QUIZ_DIR = ROOT / "quizzes"
OUT_DIR = ROOT / "_site"
CACHE_DIR = ROOT / ".cache"
ASSETS_DIR = ROOT / "assets"
TEMPLATES_DIR = ROOT / "templates"
PAGES_DIR = ROOT / "pages"

VIEWABLE = {".pdf"}
CONVERTIBLE = {".pptx", ".ppt", ".pps", ".ppsx", ".odp", ".key", ".docx", ".doc", ".odt"}
SUPPORTED = VIEWABLE | CONVERTIBLE
METADATA = {".yml", ".yaml"}
CACHE_VERSION = "4"


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def slugify(text: str) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    text = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()
    return text or "quiz"


def title_from_filename(stem: str) -> str:
    text = re.sub(r"[_\-]+", " ", stem)
    text = re.sub(r"\s+", " ", text).strip()
    if text.islower() or text.isupper():
        text = text.title()
    return text


def human_size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n} B"


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def git_added_date(path: Path) -> dt.date | None:
    """Date the file was first committed (so upload date needs no typing)."""
    try:
        out = subprocess.run(
            ["git", "log", "--diff-filter=A", "--follow", "--format=%aI", "--", str(path)],
            cwd=ROOT, capture_output=True, text=True, check=True,
        ).stdout.strip().splitlines()
    except (OSError, subprocess.CalledProcessError):
        return None
    return dt.datetime.fromisoformat(out[-1]).date() if out else None


def to_date(value) -> dt.date | None:
    if isinstance(value, dt.datetime):
        return value.date()
    if isinstance(value, dt.date):
        return value
    if isinstance(value, str) and value.strip():
        for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%Y/%m/%d", "%Y-%m", "%Y"):
            try:
                return dt.datetime.strptime(value.strip(), fmt).date()
            except ValueError:
                pass
    return None


def as_list(value) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [v.strip() for v in value.split(",") if v.strip()]
    return [str(v).strip() for v in value if str(v).strip()]


# Glyphs some Google Slides fonts export without a Unicode mapping.
PUA_GLYPHS = {"\ue081": "(", "\ue088": "-"}


def fix_symbol_chars(text: str) -> str:
    """Google Slides / Symbol-font PDFs put ASCII punctuation in the Private Use
    Area (U+F020-U+F07E -> ' '..'~'). Map those back and drop other PUA glyphs."""
    out = []
    for ch in text:
        o = ord(ch)
        if ch in PUA_GLYPHS:
            out.append(PUA_GLYPHS[ch])
        elif 0xF020 <= o <= 0xF07E:
            out.append(chr(o - 0xF000))
        elif 0xE000 <= o <= 0xF8FF:
            continue
        else:
            out.append(ch)
    return "".join(out)


def clean_text(text: str) -> str:
    text = fix_symbol_chars(text)
    lines = [re.sub(r"[ \t ]+", " ", ln).strip() for ln in text.splitlines()]
    out, blank = [], False
    for ln in lines:
        if not ln:
            blank = bool(out)
            continue
        if blank:
            out.append("")
            blank = False
        out.append(ln)
    return "\n".join(out)


def summarize(pages: list[str], limit: int = 155) -> str:
    text = " ".join(" ".join(p.split()) for p in pages if p.strip())
    if len(text) <= limit:
        return text
    return text[:limit].rsplit(" ", 1)[0].rstrip(",.;:-") + "…"


# --------------------------------------------------------------------------- #
# Conversion + extraction (cached by file hash)
# --------------------------------------------------------------------------- #

# Keep pictures at full resolution and quality when converting PPTX/DOCX to PDF
# (LibreOffice otherwise downsamples to 300 DPI and re-compresses as JPEG 90%).
LO_PDF_OPTIONS = json.dumps({
    "ReduceImageResolution": {"type": "boolean", "value": "false"},
    "UseLosslessCompression": {"type": "boolean", "value": "true"},
    "Quality": {"type": "long", "value": "100"},
    "ExportNotes": {"type": "boolean", "value": "false"},
}, separators=(",", ":"))


def export_filter(src: Path) -> str:
    ext = src.suffix.lower()
    if ext in {".docx", ".doc", ".odt"}:
        return "writer_pdf_Export"
    return "impress_pdf_Export"


def find_soffice() -> str | None:
    for name in ("soffice", "libreoffice"):
        if shutil.which(name):
            return shutil.which(name)
    mac = "/Applications/LibreOffice.app/Contents/MacOS/soffice"
    return mac if Path(mac).exists() else None


# --------------------------------------------------------------------------- #
# Fonts: fetch the Google Fonts a deck uses so LibreOffice renders it faithfully
# --------------------------------------------------------------------------- #

FONT_DIR = CACHE_DIR / "fonts"
STYLE_WORDS = {"thin": 100, "extralight": 200, "ultralight": 200, "light": 300, "regular": 400, "book": 400,
               "normal": 400, "medium": 500, "semibold": 600, "demibold": 600, "bold": 700, "extrabold": 800,
               "ultrabold": 800, "black": 900, "heavy": 900}
ITALIC_WORDS = {"italic", "italics", "oblique"}


def deck_typefaces(src: Path) -> set[str]:
    import zipfile
    names: set[str] = set()
    try:
        with zipfile.ZipFile(src) as z:
            for n in z.namelist():
                if n.endswith(".xml") and n.startswith(("ppt/", "word/")):
                    names.update(re.findall(r'typeface="([^"+][^"]*)"', z.read(n).decode("utf-8", "ignore")))
    except zipfile.BadZipFile:
        pass
    return {n.strip() for n in names if n.strip()}


def split_style(name: str) -> tuple[str, int, bool]:
    """'Inter Bold Italics' -> ('Inter', 700, True). Canva writes styles into the name."""
    words, weight, italic = name.split(), 400, False
    while len(words) > 1:
        w = words[-1].lower().replace("-", "")
        if w in ITALIC_WORDS:
            italic = True
        elif w in STYLE_WORDS:
            weight = STYLE_WORDS[w]
        else:
            break
        words.pop()
    return " ".join(words), weight, italic


def installed_families() -> set[str]:
    try:
        out = subprocess.run(["fc-list", ":", "family"], capture_output=True, text=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError):
        return set()
    return {f.strip().lower() for line in out.splitlines() for f in line.split(",")}


def fetch_google_font(family: str) -> bool:
    """Download the TTFs of a Google Fonts family (regular/bold × upright/italic)."""
    import urllib.error
    import urllib.request
    dest = FONT_DIR / slugify(family)
    if dest.exists() and any(dest.glob("*.ttf")):
        return True
    q = quote(family).replace("%20", "+")
    for axes in (":ital,wght@0,400;0,700;1,400;1,700", ":wght@400;700", ":ital@0;1", ""):
        try:
            with urllib.request.urlopen(f"https://fonts.googleapis.com/css2?family={q}{axes}", timeout=20) as r:
                css = r.read().decode()
            break
        except (urllib.error.URLError, OSError):
            css = ""
    urls = re.findall(r"font-style:\s*(\w+);\s*font-weight:\s*(\d+);.*?src:\s*url\(([^)]+\.ttf)\)", css, re.S)
    if not urls:
        return False
    dest.mkdir(parents=True, exist_ok=True)
    for style, weight, url in urls:
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                (dest / f"{slugify(family)}-{weight}-{style}.ttf").write_bytes(r.read())
        except (urllib.error.URLError, OSError):
            pass
    return any(dest.glob("*.ttf"))


def font_env(src: Path) -> dict:
    """Environment for LibreOffice with the deck's fonts available and Canva-style
    names ('Inter Bold') mapped to real family + weight."""
    faces = deck_typefaces(src)
    if not faces:
        return dict(os.environ)
    have = installed_families()
    aliases = []
    for face in sorted(faces):
        family, weight, italic = split_style(face)
        if family.lower() not in have and family.lower() not in {"arial", "calibri", "cambria", "times new roman"}:
            if fetch_google_font(family):
                print(f"    font: {family}")
            have.add(family.lower())
        if face != family:
            aliases.append((face, family, weight, italic))
    FONT_DIR.mkdir(parents=True, exist_ok=True)
    rules = "".join(
        f'<match target="pattern"><test name="family"><string>{html_escape(face)}</string></test>'
        f'<edit name="family" mode="assign" binding="strong"><string>{html_escape(family)}</string></edit>'
        f'<edit name="weight" mode="assign" binding="strong"><int>{ {400: 80, 700: 200}.get(weight, 80 if weight < 550 else 200) }</int></edit>'
        + ('<edit name="slant" mode="assign" binding="strong"><const>italic</const></edit>' if italic else "")
        + "</match>"
        for face, family, weight, italic in aliases)
    conf = FONT_DIR / "fonts.conf"
    conf.write_text('<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig>'
                    '<include ignore_missing="yes">/etc/fonts/fonts.conf</include>'
                    f"<dir>{FONT_DIR.resolve()}</dir>{rules}</fontconfig>")
    return {**os.environ, "FONTCONFIG_FILE": str(conf.resolve())}


def html_escape(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def convert_to_pdf(src: Path, workdir: Path) -> Path:
    soffice = find_soffice()
    if not soffice:
        raise RuntimeError(
            f"LibreOffice is needed to convert {src.name} to PDF but was not found. "
            "Install LibreOffice, or upload a PDF export alongside it."
        )
    workdir.mkdir(parents=True, exist_ok=True)
    profile = (CACHE_DIR / "lo-profile").resolve().as_uri()
    proc = subprocess.run(
        [soffice, f"-env:UserInstallation={profile}", "--headless", "--norestore",
         "--convert-to", f"pdf:{export_filter(src)}:{LO_PDF_OPTIONS}", "--outdir", str(workdir), str(src)],
        capture_output=True, text=True, timeout=600, env=font_env(src),
    )
    pdf = workdir / (src.stem + ".pdf")
    if not pdf.exists():
        raise RuntimeError(f"LibreOffice could not convert {src.name}: "
                           f"{(proc.stderr or proc.stdout).strip()[-300:]}")
    return pdf


def process_document(src: Path) -> dict:
    """Return {pdf, thumb, pages, width, height} for src, using the cache."""
    key = hashlib.sha256((CACHE_VERSION + sha256(src)).encode()).hexdigest()[:24]
    cdir = CACHE_DIR / "docs" / key
    meta_path = cdir / "meta.json"
    if meta_path.exists():
        meta = json.loads(meta_path.read_text())
    else:
        print(f"  processing {src.name}")
        tmp = cdir.with_suffix(".tmp")
        shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir(parents=True)
        pdf = src if src.suffix.lower() == ".pdf" else convert_to_pdf(src, tmp)
        with pymupdf.open(pdf) as doc:
            pages = [clean_text(p.get_text("text", sort=True)) for p in doc]
            first = doc[0]
            width, height = first.rect.width, first.rect.height
            zoom = 1280 / max(width, 1)  # large enough for sharp cards and social previews
            pix = first.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
            pix.save(tmp / "thumb.jpg", jpg_quality=90)
        if pdf != src:
            pdf.rename(tmp / "doc.pdf")
        meta = {"pages": pages, "width": width, "height": height,
                "converted": pdf != src}
        (tmp / "meta.json").write_text(json.dumps(meta))
        shutil.rmtree(cdir, ignore_errors=True)
        tmp.rename(cdir)
    meta["thumb"] = cdir / "thumb.jpg"
    meta["pdf"] = cdir / "doc.pdf" if meta["converted"] else src
    return meta


# --------------------------------------------------------------------------- #
# Model
# --------------------------------------------------------------------------- #

@dataclass
class Download:
    label: str
    ext: str
    url: str
    size: str
    filename: str


@dataclass
class Quiz:
    slug: str
    title: str
    description: str
    summary: str
    date: dt.date
    tags: list[str]
    event: str
    quizmasters: list[str]
    language: str
    pages: list[str]
    aspect: float
    pdf_url: str
    thumb_url: str
    downloads: list[Download] = field(default_factory=list)
    featured: bool = False
    body_html: str = ""
    media: list[dict] = field(default_factory=list)

    @property
    def has_av(self) -> bool:
        return any(m["k"] != "link" for m in self.media)

    def media_on(self, slide: int) -> list[dict]:
        return [m for m in self.media if m["s"] == slide and m["k"] != "link"]

    @property
    def slide_count(self) -> int:
        return len(self.pages)

    @property
    def search_text(self) -> str:
        return " ".join([self.title, self.description, self.event, " ".join(self.tags)]).lower()


def load_metadata(stem_group: list[Path]) -> dict:
    for p in stem_group:
        if p.suffix.lower() in METADATA:
            data = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
            if not isinstance(data, dict):
                raise ValueError(f"{p.name} must contain 'key: value' lines")
            return data
    return {}


PART_RE = re.compile(r"^(?P<name>.+\.[A-Za-z0-9]+)\.part(?P<n>\d+)$")
# Joined-up copies of files uploaded in parts -> the first part (for git dates).
ASSEMBLED_FROM: dict[Path, Path] = {}


def assemble_parts(parts: dict[Path, list[tuple[int, Path]]]) -> list[Path]:
    """Large uploads are stored as 'name.pptx.part01', 'part02'…; join them."""
    out = []
    for logical, pieces in parts.items():
        pieces.sort()
        dest = CACHE_DIR / "assembled" / logical.relative_to(QUIZ_DIR)
        dest.parent.mkdir(parents=True, exist_ok=True)
        with dest.open("wb") as fh:
            for _, piece in pieces:
                with piece.open("rb") as src:
                    shutil.copyfileobj(src, fh, 1 << 20)
        ASSEMBLED_FROM[dest] = pieces[0][1]
        out.append(dest)
    return out


def clip_paths(stem: str) -> list[Path]:
    """Files in 'quizzes/<quiz name>.media/' (big ones were uploaded in parts)."""
    found = {}
    for folder in (QUIZ_DIR / f"{stem}.media", CACHE_DIR / "assembled" / f"{stem}.media"):
        if folder.is_dir():
            for p in folder.iterdir():
                if p.is_file() and not PART_RE.match(p.name) and not p.name.startswith("."):
                    found.setdefault(p.name, p)
    return list(found.values())


def find_media(docs: list[Path], pdf: Path, page_count: int, meta: dict, out_dir: Path,
               url_prefix: str, page_texts: list[str] | None = None, stem: str = "") -> list[dict]:
    """Audio/video for the viewer: the .yml, uploaded clips, any PPTX, and the PDF's links."""
    groups = []
    try:
        groups.append(av.meta_media(meta.get("media"), page_count))
        if stem:
            groups.append(av.uploaded_clips(clip_paths(stem), page_count, out_dir, url_prefix, CACHE_DIR))
        for d in docs:
            if d.suffix.lower() in {".pptx", ".ppsx"}:
                groups.append(av.pptx_media(d, out_dir, url_prefix, page_count, CACHE_DIR, page_texts))
        with pymupdf.open(pdf) as doc:
            groups.append(av.pdf_media(doc))
    except Exception as exc:  # never let media problems break the site
        print(f"  ! media in {docs[0].name}: {exc}", file=sys.stderr)
    items = av.merge(*groups)
    clips = sum(1 for i in items if i["k"] != "link")
    if clips:
        print(f"    {clips} audio/video item(s) in {docs[0].name}")
    return items


def collect_quizzes(site: dict, base: str) -> list[Quiz]:
    groups: dict[str, list[Path]] = {}
    parts: dict[Path, list[tuple[int, Path]]] = {}
    for p in sorted(QUIZ_DIR.rglob("*")):
        if not p.is_file() or p.name.startswith((".", "~$")):
            continue
        m = PART_RE.match(p.name)
        if m:
            parts.setdefault(p.with_name(m["name"]), []).append((int(m["n"]), p))
            continue
        if any(d.endswith(".media") for d in p.relative_to(QUIZ_DIR).parts[:-1]):
            continue  # audio/video clips uploaded for a quiz, handled by find_media
        ext = p.suffix.lower()
        if ext in SUPPORTED or ext in METADATA:
            groups.setdefault(str(p.with_suffix("").relative_to(QUIZ_DIR)), []).append(p)
    for logical, joined in zip(parts, assemble_parts(parts)):
        if logical.suffix.lower() in SUPPORTED:
            groups.setdefault(str(logical.with_suffix("").relative_to(QUIZ_DIR)), []).append(joined)

    quizzes: list[Quiz] = []
    used_slugs: set[str] = set()
    for stem, paths in groups.items():
        docs = [p for p in paths if p.suffix.lower() in SUPPORTED]
        if not docs:
            print(f"  ! {stem}.yml has no matching quiz file — skipped")
            continue
        meta = load_metadata(paths)
        # Prefer an uploaded PDF for viewing (pixel-perfect); otherwise convert.
        docs.sort(key=lambda p: (p.suffix.lower() != ".pdf", p.suffix.lower()))
        try:
            info = process_document(docs[0])
        except Exception as exc:  # keep building the rest of the site
            print(f"  ! could not process {docs[0].name}: {exc}", file=sys.stderr)
            continue

        slug = slugify(str(meta.get("slug") or Path(stem).name))
        base_slug, n = slug, 2
        while slug in used_slugs:
            slug, n = f"{base_slug}-{n}", n + 1
        used_slugs.add(slug)

        title = str(meta.get("title") or title_from_filename(Path(stem).name))
        date = (to_date(meta.get("date")) or git_added_date(ASSEMBLED_FROM.get(docs[0], docs[0]))
                or dt.date.fromtimestamp(docs[0].stat().st_mtime))

        fdir = OUT_DIR / "files" / slug
        fdir.mkdir(parents=True, exist_ok=True)
        downloads = []
        for d in docs:
            ext = d.suffix.lower().lstrip(".")
            name = f"{slug}.{ext}"
            shutil.copy2(d, fdir / name)
            downloads.append(Download(ext.upper(), ext, f"{base}files/{slug}/{name}",
                                      human_size(d.stat().st_size), f"{title}.{ext}"))
        if info["converted"]:
            shutil.copy2(info["pdf"], fdir / f"{slug}.pdf")
            downloads.append(Download("PDF", "pdf", f"{base}files/{slug}/{slug}.pdf",
                                      human_size(info["pdf"].stat().st_size), f"{title}.pdf"))
        shutil.copy2(info["thumb"], fdir / "cover.jpg")

        pages = info["pages"]
        media = find_media(docs, info["pdf"], len(pages), meta, fdir / "media", f"{base}files/{slug}/media/", pages, stem)
        # Shown on the page only if you wrote one; search engines still get a summary.
        description = str(meta.get("description") or "").strip()
        qms = as_list(meta.get("quizmaster") or meta.get("quizmasters") or site["author"])
        summary = description or (f"{title}: a quiz set with questions and answers ({len(pages)} slides)"
                                  f" by {', '.join(qms)}. View online, download or share.")
        quizzes.append(Quiz(
            slug=slug,
            title=title,
            description=description,
            summary=summary,
            date=date,
            tags=as_list(meta.get("tags")),
            event=str(meta.get("event") or ""),
            quizmasters=as_list(meta.get("quizmaster") or meta.get("quizmasters") or site["author"]),
            language=str(meta.get("language") or site.get("language") or "en"),
            pages=pages,
            aspect=round(info["width"] / max(info["height"], 1), 4),
            pdf_url=f"{base}files/{slug}/{slug}.pdf",
            thumb_url=f"{base}files/{slug}/cover.jpg",
            downloads=downloads,
            featured=bool(meta.get("featured")),
            body_html=markdown.markdown(str(meta.get("notes") or "")),
            media=media,
        ))
    quizzes.sort(key=lambda q: (q.date, q.title), reverse=True)
    return quizzes


# --------------------------------------------------------------------------- #
# Rendering
# --------------------------------------------------------------------------- #

PHOTO_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".heic", ".heif"}
CAMERA_NAME = re.compile(r"^(img|dsc|dscn|pxl|mvimg|photo|image|screenshot|whatsapp image|signal)[\W_]|^[\d\W_]+$", re.I)


def caption_from_name(stem: str) -> str:
    """'Winners - XYZ Quiz 2025' -> that text; camera names like IMG_2031 -> ''."""
    text = re.sub(r"\s+", " ", stem.replace("_", " ")).strip()
    return "" if CAMERA_NAME.search(stem) else text


def build_gallery(base: str) -> list[dict]:
    """About-page photos, resized for the web (cached). pages/gallery.json sets the
    order, captions and main photo; any other photo dropped into pages/gallery/ is
    added at the end, captioned from its file name."""
    from PIL import Image, ImageOps
    try:  # iPhone photos
        from pillow_heif import register_heif_opener
        register_heif_opener()
    except ImportError:
        pass
    src_json = PAGES_DIR / "gallery.json"
    entries = []
    if src_json.exists():
        try:
            entries = json.loads(src_json.read_text(encoding="utf-8")).get("photos", [])
        except ValueError as exc:
            print(f"  ! pages/gallery.json: {exc}", file=sys.stderr)
    listed = {str(e.get("file", "")) for e in entries}
    folder = PAGES_DIR / "gallery"
    if folder.is_dir():
        entries += [{"file": f.name, "caption": caption_from_name(f.stem)}
                    for f in sorted(folder.iterdir(), key=lambda f: f.name.lower())
                    if f.suffix.lower() in PHOTO_EXT and f.name not in listed]
    out_dir = OUT_DIR / "assets" / "gallery"
    cache = CACHE_DIR / "gallery"
    out_dir.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)
    photos = []
    for e in entries:
        src = PAGES_DIR / "gallery" / str(e.get("file", ""))
        if not src.is_file():
            print(f"  ! gallery photo missing: {src.name}", file=sys.stderr)
            continue
        key = sha256(src)[:16]
        made = {}
        for label, size in (("large", 1800), ("thumb", 720)):
            name = f"{slugify(src.stem)}-{key}-{size}.jpg"
            cached = cache / name
            if not cached.exists():
                try:
                    with Image.open(src) as im:
                        im = ImageOps.exif_transpose(im).convert("RGB")
                        im.thumbnail((size, size), Image.LANCZOS)
                        im.save(cached, quality=84 if label == "large" else 80, optimize=True, progressive=True)
                except OSError as exc:
                    print(f"  ! gallery photo {src.name} can't be read ({exc}); save it as JPG", file=sys.stderr)
                    break
            shutil.copy2(cached, out_dir / name)
            with Image.open(cached) as im:
                made[label] = {"url": f"{base}assets/gallery/{name}", "w": im.width, "h": im.height}
        if len(made) < 2:
            continue
        photos.append({"file": src.name, "caption": str(e.get("caption") or "").strip(), "main": bool(e.get("main")),
                       "focus": str(e.get("focus") or "50% 30%"),
                       "large": made["large"], "thumb": made["thumb"]})
    if photos and not any(p["main"] for p in photos):
        photos[0]["main"] = True
    return photos


def write_redirects(site: dict) -> None:
    """Pages that moved (e.g. /QM/quiz/x/ -> /quiz/x/ after the site moved to the
    root of its domain) get a tiny page that forwards visitors and search engines."""
    base = site["base"]
    old_bases = [b.strip("/") for b in site.get("old_bases") or [] if b.strip("/") and "/" + b.strip("/") + "/" != base]
    if not old_bases:
        return
    pages = [p.relative_to(OUT_DIR) for p in OUT_DIR.rglob("index.html")]
    for old in old_bases:
        for rel in pages:
            target = site["url"] + ("" if rel.parent == Path(".") else rel.parent.as_posix() + "/")
            stub = OUT_DIR / old / rel
            stub.parent.mkdir(parents=True, exist_ok=True)
            stub.write_text(
                '<!doctype html><meta charset="utf-8"><title>Moved</title>'
                f'<link rel="canonical" href="{target}">'
                f'<meta http-equiv="refresh" content="0; url={target}">'
                f'<p>This page has moved to <a href="{target}">{target}</a>.</p>', encoding="utf-8")
        # Old file links (PDF/PPTX downloads, images) and anything else: forward from the 404 page.
    if (OUT_DIR / "404.html").exists():
        html = (OUT_DIR / "404.html").read_text(encoding="utf-8")
        js = ("<script>(function(){var p=location.pathname,o=%s;for(var i=0;i<o.length;i++)"
              "if(p==='/'+o[i]||p.indexOf('/'+o[i]+'/')===0){location.replace(%s+p.slice(o[i].length+2)+location.search+location.hash);return}})()</script>"
              % (json.dumps(old_bases), json.dumps(base)))
        (OUT_DIR / "404.html").write_text(html.replace("<head>", "<head>" + js, 1), encoding="utf-8")


def site_url(site: dict) -> str:
    url = (os.environ.get("SITE_URL") if not site.get("url") else site["url"]) or "http://localhost:8000/"
    return url.rstrip("/") + "/"


def build(site: dict) -> list[Quiz]:
    url = site_url(site)
    base = urlsplit(url).path or "/"
    site = {**site, "url": url, "base": base, "year": dt.date.today().year,
            "links": site.get("links") or []}
    if os.environ.get("GITHUB_REPOSITORY"):  # CI knows the repo, even after a rename
        site["github_repo"] = os.environ["GITHUB_REPOSITORY"]

    if OUT_DIR.exists():
        shutil.rmtree(OUT_DIR)
    OUT_DIR.mkdir(parents=True)
    CACHE_DIR.mkdir(exist_ok=True)

    print("Collecting quizzes…")
    quizzes = collect_quizzes(site, base)
    print(f"  {len(quizzes)} quiz set(s)")

    tags: dict[str, list[Quiz]] = {}
    for q in quizzes:
        for t in q.tags:
            tags.setdefault(t, []).append(q)
    tag_list = sorted(((t, slugify(t), len(qs)) for t, qs in tags.items()),
                      key=lambda x: (-x[2], x[0].lower()))

    env = jinja2.Environment(
        loader=jinja2.FileSystemLoader(TEMPLATES_DIR),
        autoescape=jinja2.select_autoescape(["html", "xml"]),
        trim_blocks=True, lstrip_blocks=True, keep_trailing_newline=True,
    )
    env.filters["slugify"] = slugify
    env.filters["tojson_ld"] = lambda o: jinja2.utils.markupsafe.Markup(
        json.dumps(o, ensure_ascii=False, indent=2).replace("</", "<\\/"))
    env.filters["rfc822"] = lambda d: email.utils.format_datetime(
        dt.datetime.combine(d, dt.time(9, 0), dt.timezone.utc))
    env.filters["pretty_date"] = lambda d: d.strftime("%-d %b %Y")
    env.filters["initials"] = lambda s: "".join(w[0] for w in str(s).split()[:2]).upper() or "Q"
    env.filters["org_ld"] = lambda n: {"@type": "CollegeOrUniversity", "name": n}
    env.filters["urlquote"] = lambda s: quote(str(s), safe="")
    def absolute(path: str) -> str:
        return url + path[len(base):] if path.startswith(base) else path

    def quiz_ld(q: Quiz) -> dict:
        page = page_url(f"quiz/{q.slug}/")
        ld = {
            "@context": "https://schema.org",
            "@type": ["Quiz", "PresentationDigitalDocument"],
            "@id": page + "#quiz",
            "name": q.title,
            "headline": q.title,
            "description": q.summary,
            "url": page,
            "image": absolute(q.thumb_url),
            "thumbnailUrl": absolute(q.thumb_url),
            "datePublished": q.date.isoformat(),
            "inLanguage": q.language,
            "keywords": ", ".join(q.tags + ["quiz", "quiz questions", "quiz with answers"]),
            "about": [{"@type": "Thing", "name": t} for t in q.tags] or None,
            "educationalUse": "quiz",
            "learningResourceType": "Quiz",
            "numberOfPages": q.slide_count,
            "isAccessibleForFree": True,
            "author": [{"@type": "Person", "name": n} for n in q.quizmasters],
            "publisher": {"@type": "Person", "name": site["author"], "url": url},
            "isPartOf": {"@type": "WebSite", "name": site["title"], "url": url},
            "encoding": [{"@type": "MediaObject", "contentUrl": absolute(d.url),
                          "encodingFormat": d.ext, "contentSize": d.size} for d in q.downloads],
            "text": "\n\n".join(f"Slide {i}: {t}" for i, t in enumerate(q.pages, 1) if t)[:5000],
            "recordedAt": {"@type": "Event", "name": q.event} if q.event else None,
        }
        return {k: v for k, v in ld.items() if v is not None}

    def item_list(qs: list[Quiz]) -> list[dict]:
        return [{"@type": "ListItem", "position": i, "url": page_url(f"quiz/{q.slug}/"),
                 "name": q.title} for i, q in enumerate(qs, 1)]

    env.globals.update(site=site, tag_list=tag_list, quiz_ld=quiz_ld,
                       item_list=item_list, absolute=absolute)

    def write(rel: str, template: str, **ctx):
        path = OUT_DIR / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(env.get_template(template).render(**ctx), encoding="utf-8")

    def page_url(rel: str) -> str:
        return url + rel

    write("index.html", "index.html", quizzes=quizzes, canonical=url)
    for q in quizzes:
        write(f"quiz/{q.slug}/index.html", "quiz.html", q=q,
              canonical=page_url(f"quiz/{q.slug}/"),
              related=sorted((o for o in quizzes if o is not q),
                             key=lambda o: (-len(set(o.tags) & set(q.tags)), -o.date.toordinal()))[:8])
        write(f"quiz/{q.slug}/index.md", "quiz.md", q=q, canonical=page_url(f"quiz/{q.slug}/"))
        write(f"embed/{q.slug}/index.html", "embed.html", q=q,
              canonical=page_url(f"quiz/{q.slug}/"))
    write("tags/index.html", "tags.html", canonical=page_url("tags/"))
    for tag, qs in tags.items():
        write(f"tags/{slugify(tag)}/index.html", "tag.html", tag=tag, quizzes=qs,
              canonical=page_url(f"tags/{slugify(tag)}/"))

    gallery = build_gallery(base)
    about_md = PAGES_DIR / "about.md"
    about_html = markdown.markdown(about_md.read_text(encoding="utf-8")) if about_md.exists() else ""
    # The page heading sits above the main photo, so split it off the Markdown body.
    m = re.match(r"\s*<h1>(.*?)</h1>\s*", about_html, re.S)
    about_title, about_html = (m.group(1), about_html[m.end():]) if m else ("", about_html)
    write("about/index.html", "about.html", body=about_html, heading=about_title, quizzes=quizzes, gallery=gallery,
          canonical=page_url("about/"))
    # The Manage page reads this to show thumbnails of the current About photos.
    (OUT_DIR / "gallery.json").write_text(json.dumps(
        [{"file": p["file"], "caption": p["caption"], "main": p["main"], "thumb": p["thumb"]["url"]} for p in gallery],
        indent=2, ensure_ascii=False), encoding="utf-8")
    write("404.html", "404.html", canonical=url)
    write("upload/index.html", "upload.html", canonical=page_url("upload/"))

    write("sitemap.xml", "sitemap.xml", quizzes=quizzes, tags=tags)
    write("feed.xml", "feed.xml", quizzes=quizzes)
    write("robots.txt", "robots.txt")
    write("llms.txt", "llms.txt", quizzes=quizzes)
    write("llms-full.txt", "llms-full.txt", quizzes=quizzes)
    (OUT_DIR / "quizzes.json").write_text(json.dumps([{
        "title": q.title, "url": page_url(f"quiz/{q.slug}/"), "description": q.summary,
        "date": q.date.isoformat(), "tags": q.tags, "event": q.event,
        "slides": q.slide_count, "cover": url + q.thumb_url[len(base):],
        "downloads": {d.ext: url + d.url[len(base):] for d in q.downloads},
    } for q in quizzes], indent=2, ensure_ascii=False), encoding="utf-8")

    shutil.copytree(ASSETS_DIR, OUT_DIR / "assets", dirs_exist_ok=True)
    (OUT_DIR / ".nojekyll").touch()
    write_redirects(site)
    if site.get("indexnow_key"):
        (OUT_DIR / f"{site['indexnow_key']}.txt").write_text(site["indexnow_key"])
    cname = urlsplit(url).hostname or ""
    if site.get("url") and not cname.endswith(("github.io", "localhost")):
        (OUT_DIR / "CNAME").write_text(cname + "\n")
    print(f"Built {OUT_DIR.relative_to(ROOT)}/ for {url}")
    return quizzes


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--serve", action="store_true", help="preview the site after building")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()

    site = yaml.safe_load((ROOT / "site.yml").read_text(encoding="utf-8")) or {}
    if args.serve:  # preview locally regardless of the configured domain
        site["url"] = f"http://localhost:{args.port}/"
    build(site)

    if args.serve:
        import functools
        import http.server
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(OUT_DIR))
        print(f"Serving on http://localhost:{args.port}/  (Ctrl+C to stop)")
        http.server.ThreadingHTTPServer(("", args.port), handler).serve_forever()


if __name__ == "__main__":
    main()
