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
CACHE_VERSION = "1"


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


def clean_text(text: str) -> str:
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

def find_soffice() -> str | None:
    for name in ("soffice", "libreoffice"):
        if shutil.which(name):
            return shutil.which(name)
    mac = "/Applications/LibreOffice.app/Contents/MacOS/soffice"
    return mac if Path(mac).exists() else None


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
         "--convert-to", "pdf", "--outdir", str(workdir), str(src)],
        capture_output=True, text=True, timeout=600,
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
            zoom = 720 / max(width, 1)
            pix = first.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
            pix.save(tmp / "thumb.jpg", jpg_quality=82)
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


def collect_quizzes(site: dict, base: str) -> list[Quiz]:
    groups: dict[str, list[Path]] = {}
    for p in sorted(QUIZ_DIR.rglob("*")):
        if not p.is_file() or p.name.startswith((".", "~$")):
            continue
        ext = p.suffix.lower()
        if ext in SUPPORTED or ext in METADATA:
            groups.setdefault(str(p.with_suffix("").relative_to(QUIZ_DIR)), []).append(p)

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
        date = (to_date(meta.get("date")) or git_added_date(docs[0])
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
        description = str(meta.get("description") or "").strip()
        if not description:
            description = (f"{title}: a quiz set with questions and answers ({len(pages)} slides)"
                           f" by {site['author']}. View online, download or share.")
        quizzes.append(Quiz(
            slug=slug,
            title=title,
            description=description,
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
        ))
    quizzes.sort(key=lambda q: (q.date, q.title), reverse=True)
    return quizzes


# --------------------------------------------------------------------------- #
# Rendering
# --------------------------------------------------------------------------- #

def site_url(site: dict) -> str:
    url = (os.environ.get("SITE_URL") if not site.get("url") else site["url"]) or "http://localhost:8000/"
    return url.rstrip("/") + "/"


def build(site: dict) -> list[Quiz]:
    url = site_url(site)
    base = urlsplit(url).path or "/"
    site = {**site, "url": url, "base": base, "year": dt.date.today().year,
            "links": site.get("links") or []}

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
            "description": q.description,
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
              related=[o for o in quizzes if o is not q
                       and (set(o.tags) & set(q.tags) or not q.tags)][:6])
        write(f"quiz/{q.slug}/index.md", "quiz.md", q=q, canonical=page_url(f"quiz/{q.slug}/"))
        write(f"embed/{q.slug}/index.html", "embed.html", q=q,
              canonical=page_url(f"quiz/{q.slug}/"))
    write("tags/index.html", "tags.html", canonical=page_url("tags/"))
    for tag, qs in tags.items():
        write(f"tags/{slugify(tag)}/index.html", "tag.html", tag=tag, quizzes=qs,
              canonical=page_url(f"tags/{slugify(tag)}/"))

    about_md = PAGES_DIR / "about.md"
    about_html = markdown.markdown(about_md.read_text(encoding="utf-8")) if about_md.exists() else ""
    write("about/index.html", "about.html", body=about_html, quizzes=quizzes,
          canonical=page_url("about/"))
    write("404.html", "404.html", canonical=url)

    write("sitemap.xml", "sitemap.xml", quizzes=quizzes, tags=tags)
    write("feed.xml", "feed.xml", quizzes=quizzes)
    write("robots.txt", "robots.txt")
    write("llms.txt", "llms.txt", quizzes=quizzes)
    write("llms-full.txt", "llms-full.txt", quizzes=quizzes)
    (OUT_DIR / "quizzes.json").write_text(json.dumps([{
        "title": q.title, "url": page_url(f"quiz/{q.slug}/"), "description": q.description,
        "date": q.date.isoformat(), "tags": q.tags, "event": q.event,
        "slides": q.slide_count, "cover": url + q.thumb_url[len(base):],
        "downloads": {d.ext: url + d.url[len(base):] for d in q.downloads},
    } for q in quizzes], indent=2, ensure_ascii=False), encoding="utf-8")

    shutil.copytree(ASSETS_DIR, OUT_DIR / "assets")
    (OUT_DIR / ".nojekyll").touch()
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
