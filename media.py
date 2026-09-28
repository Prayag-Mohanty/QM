"""Find the audio / video in a quiz deck so the viewer can play it.

Three sources, merged per slide:
  * PPTX: embedded clips (ppt/media/*) and linked clips, with their position on
    the slide, plus hyperlinks on pictures/shapes/text (YouTube, Vimeo, …).
  * PDF: clickable link annotations (and bare YouTube/Vimeo URLs in the text).
  * The quiz's .yml ``media:`` list, e.g. ``[{"slide": 12, "url": "https://youtu.be/…"}]``.

Each item handed to the viewer is a small dict:
  {"s": slide (1-based), "k": "video"|"audio"|"embed"|"link",
   "src": url, "r": [x, y, w, h] as fractions of the slide or None, "label": str}
"""

from __future__ import annotations

import difflib
import hashlib
import posixpath
import re
import shutil
import subprocess
import zipfile
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlsplit
from xml.etree import ElementTree as ET

NS = {
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "p14": "http://schemas.microsoft.com/office/powerpoint/2010/main",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
}
R = "{%s}" % NS["r"]

VIDEO_WEB = {".mp4", ".m4v", ".webm", ".ogv", ".mov"}
AUDIO_WEB = {".mp3", ".m4a", ".aac", ".wav", ".ogg", ".oga", ".opus", ".flac"}
VIDEO_OTHER = {".wmv", ".avi", ".mpg", ".mpeg", ".mkv", ".asf", ".flv", ".3gp"}
AUDIO_OTHER = {".wma", ".aif", ".aiff", ".mid", ".midi", ".amr"}
MEDIA_EXT = VIDEO_WEB | AUDIO_WEB | VIDEO_OTHER | AUDIO_OTHER


# --------------------------------------------------------------------------- #
# URLs
# --------------------------------------------------------------------------- #

def _seconds(t: str | None) -> int:
    if not t:
        return 0
    t = t.strip()
    if t.isdigit():
        return int(t)
    if re.fullmatch(r"\d+(:\d{1,2}){1,2}", t):  # 1:23 or 1:02:03
        total = 0
        for part in t.split(":"):
            total = total * 60 + int(part)
        return total
    total = 0
    for num, unit in re.findall(r"(\d+)([hms])", t):
        total += int(num) * {"h": 3600, "m": 60, "s": 1}[unit]
    return total


def classify_url(url: str, start: int | None = None) -> dict | None:
    """Turn a link into something playable ('embed'/'video'/'audio') or a plain 'link'."""
    url = url.strip()
    if not re.match(r"^https?://", url, re.I):
        return None
    parts = urlsplit(url)
    host = (parts.hostname or "").lower().removeprefix("www.").removeprefix("m.")
    qs = parse_qs(parts.query)
    path = parts.path
    t = start if start is not None else _seconds((qs.get("t") or qs.get("start") or [None])[0]
                                                 or (parts.fragment[2:] if parts.fragment.startswith("t=") else None))

    vid = None
    if host in ("youtube.com", "music.youtube.com", "youtube-nocookie.com"):
        if path == "/watch":
            vid = (qs.get("v") or [None])[0]
        else:
            m = re.match(r"^/(?:embed|shorts|live|v)/([\w-]{6,})", path)
            vid = m and m.group(1)
    elif host == "youtu.be":
        vid = path.strip("/").split("/")[0] or None
    if vid:
        return {"k": "embed", "src": f"https://www.youtube-nocookie.com/embed/{vid}?autoplay=1&rel=0"
                + (f"&start={t}" if t else ""), "label": "YouTube"}

    if host in ("vimeo.com", "player.vimeo.com"):
        m = re.search(r"/(?:video/)?(\d{5,})", path)
        if m:
            return {"k": "embed", "src": f"https://player.vimeo.com/video/{m.group(1)}?autoplay=1"
                    + (f"#t={t}s" if t else ""), "label": "Vimeo"}
    if host == "drive.google.com":
        m = re.search(r"/file/d/([\w-]+)", path) or re.search(r"[?&]id=([\w-]+)", url)
        if m:
            return {"k": "embed", "src": f"https://drive.google.com/file/d/{m.group(1)}/preview", "label": "Google Drive"}
    if host == "open.spotify.com":
        m = re.match(r"^/(?:intl-\w+/)?(track|episode|album|playlist|show)/(\w+)", path)
        if m:
            return {"k": "embed", "src": f"https://open.spotify.com/embed/{m.group(1)}/{m.group(2)}", "label": "Spotify",
                    "audio": True}
    if host == "soundcloud.com":
        return {"k": "embed", "src": "https://w.soundcloud.com/player/?auto_play=true&url=" + quote(url, safe=""),
                "label": "SoundCloud", "audio": True}
    if host in ("dailymotion.com", "dai.ly"):
        m = re.search(r"/video/([a-z0-9]+)", path) or re.match(r"^/([a-z0-9]+)", path)
        if m:
            return {"k": "embed", "src": f"https://www.dailymotion.com/embed/video/{m.group(1)}?autoplay=1",
                    "label": "Dailymotion"}

    ext = posixpath.splitext(path.lower())[1]
    if ext in VIDEO_WEB:
        return {"k": "video", "src": url, "label": "Video"}
    if ext in AUDIO_WEB:
        return {"k": "audio", "src": url, "label": "Audio"}
    return {"k": "link", "src": url, "label": host or "Link"}


MEDIA_URL_RE = re.compile(
    r"https?://(?:www\.|m\.)?(?:youtube\.com/(?:watch\?[^\s]+|shorts/[\w-]+|embed/[\w-]+)|youtu\.be/[\w-]+[^\s]*"
    r"|vimeo\.com/\d+|open\.spotify\.com/[^\s]+|soundcloud\.com/[^\s]+|drive\.google\.com/file/d/[\w-]+[^\s]*)",
    re.I)


# --------------------------------------------------------------------------- #
# PPTX
# --------------------------------------------------------------------------- #

def _rels(z: zipfile.ZipFile, part: str) -> dict[str, tuple[str, str]]:
    """rId -> (target, mode) for a part; internal targets resolved to zip paths."""
    d, name = posixpath.split(part)
    rel_path = posixpath.join(d, "_rels", name + ".rels")
    if rel_path not in z.namelist():
        return {}
    out = {}
    for rel in ET.fromstring(z.read(rel_path)).findall("rel:Relationship", NS):
        target, mode = rel.get("Target", ""), rel.get("TargetMode", "Internal")
        if mode != "External":
            target = posixpath.normpath(posixpath.join(d, target))
        out[rel.get("Id")] = (target, mode)
    return out


def _rect(el, sw: int, sh: int) -> list[float] | None:
    xfrm = el.find("./p:spPr/a:xfrm", NS)
    if xfrm is None:
        return None
    off, ext = xfrm.find("a:off", NS), xfrm.find("a:ext", NS)
    if off is None or ext is None or not sw or not sh:
        return None
    x, y = int(off.get("x", 0)) / sw, int(off.get("y", 0)) / sh
    w, h = int(ext.get("cx", 0)) / sw, int(ext.get("cy", 0)) / sh
    if w <= 0 or h <= 0:
        return None
    clip = lambda v: round(min(max(v, 0.0), 1.0), 4)  # noqa: E731
    return [clip(x), clip(y), clip(min(w, 1 - x)), clip(min(h, 1 - y))]


def pptx_slides(path: Path) -> tuple[list[tuple[str, bool]], int, int]:
    """[(slide part, hidden)], slide width, slide height (EMU)."""
    with zipfile.ZipFile(path) as z:
        pres = ET.fromstring(z.read("ppt/presentation.xml"))
        rels = _rels(z, "ppt/presentation.xml")
        size = pres.find("p:sldSz", NS)
        sw, sh = (int(size.get("cx")), int(size.get("cy"))) if size is not None else (12192000, 6858000)
        slides = []
        for sid in pres.findall("./p:sldIdLst/p:sldId", NS):
            part = rels.get(sid.get(R + "id"), ("", ""))[0]
            if part in z.namelist():
                hidden = ET.fromstring(z.read(part)).get("show") == "0"
                slides.append((part, hidden))
    return slides, sw, sh


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()[:400]


def align_slides(slide_texts: list[str], page_texts: list[str]) -> dict[int, int]:
    """Match PPTX slides to PDF pages by their text (both 0-based), tolerating
    slides that exist in only one of them — e.g. a PDF exported without a few
    slides. Needleman–Wunsch alignment on text similarity."""
    a = [_norm(t) for t in slide_texts]
    b = [_norm(t) for t in page_texts]
    n, m = len(a), len(b)
    if a == b:
        return {i: i for i in range(n)}
    gap = -0.45

    def score(i: int, j: int) -> float:
        x, y = a[i], b[j]
        if not x and not y:
            return 0.35                      # two picture-only slides
        if not x or not y:
            return -0.6
        return difflib.SequenceMatcher(None, x, y, autojunk=False).ratio() * 2 - 1

    dp = [[0.0] * (m + 1) for _ in range(n + 1)]
    move = [[0] * (m + 1) for _ in range(n + 1)]   # 0 diag, 1 up (skip slide), 2 left (skip page)
    for i in range(1, n + 1):
        dp[i][0], move[i][0] = i * gap, 1
    for j in range(1, m + 1):
        dp[0][j], move[0][j] = j * gap, 2
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            best, mv = dp[i - 1][j - 1] + score(i - 1, j - 1), 0
            if dp[i - 1][j] + gap > best:
                best, mv = dp[i - 1][j] + gap, 1
            if dp[i][j - 1] + gap > best:
                best, mv = dp[i][j - 1] + gap, 2
            dp[i][j], move[i][j] = best, mv
    mapping, i, j = {}, n, m
    while i > 0 and j > 0:
        mv = move[i][j]
        if mv == 0:
            mapping[i - 1] = j - 1
            i, j = i - 1, j - 1
        elif mv == 1:
            i -= 1
        else:
            j -= 1
    return mapping


def pptx_slide_texts(z: zipfile.ZipFile, parts: list[str]) -> list[str]:
    return [" ".join(re.findall(r"<a:t>([^<]*)</a:t>", z.read(p).decode("utf-8", "ignore"))) for p in parts]


def pptx_media(path: Path, out_dir: Path, url_prefix: str, page_count: int, cache_dir: Path,
               page_texts: list[str] | None = None) -> list[dict]:
    """Extract clips + media links from a PPTX, numbered to match the PDF pages.

    With ``page_texts`` (the PDF's text per page) slides are matched to pages by
    content, so clips land on the right page even if the PDF has fewer slides."""
    slides, sw, sh = pptx_slides(path)
    visible = [s for s in slides if not s[1]]
    # Exported PDFs usually skip hidden slides; pick the numbering that matches.
    order = visible if len(visible) == page_count and len(slides) != page_count else slides
    items: list[dict] = []
    with zipfile.ZipFile(path) as z:
        names = set(z.namelist())
        page_of = {i: i for i in range(len(order))}
        if page_texts is not None and (len(order) != len(page_texts)
                                       or any(_norm(a) != _norm(b) for a, b in
                                              zip(pptx_slide_texts(z, [s[0] for s in order]), page_texts))):
            page_of = align_slides(pptx_slide_texts(z, [s[0] for s in order]), page_texts)
        for idx, (part, _hidden) in enumerate(order):
            if idx not in page_of:
                continue  # slide isn't in the PDF
            num = page_of[idx] + 1
            rels = _rels(z, part)
            root = ET.fromstring(z.read(part))
            seen: set[str] = set()

            def add(item: dict | None, rect):
                if not item or item["src"] in seen:
                    return
                seen.add(item["src"])
                items.append({"s": num, "r": rect, **item})

            for pic in root.iter("{%s}pic" % NS["p"]):
                rect = _rect(pic, sw, sh)
                nvpr = pic.find("./p:nvPicPr/p:nvPr", NS)
                if nvpr is not None:
                    media_el = nvpr.find(".//p14:media", NS)
                    vf = nvpr.find("a:videoFile", NS)
                    af = nvpr.find("a:audioFile", NS)
                    kind = "video" if vf is not None else "audio" if af is not None else None
                    target = None
                    if media_el is not None and media_el.get(R + "embed") in rels:
                        target = rels[media_el.get(R + "embed")]
                    elif (vf if vf is not None else af) is not None:
                        rid = (vf if vf is not None else af).get(R + "link")
                        target = rels.get(rid)
                    if target and kind:
                        tgt, mode = target
                        if mode == "External":
                            add(classify_url(tgt), rect)
                        elif tgt in names:
                            add(_publish_clip(z, tgt, kind, out_dir, url_prefix, cache_dir), rect)
                        continue
                # A picture with a click-through link (e.g. a YouTube thumbnail).
                click = pic.find("./p:nvPicPr/p:cNvPr/a:hlinkClick", NS)
                if click is not None and click.get(R + "id") in rels:
                    tgt, mode = rels[click.get(R + "id")]
                    if mode == "External":
                        add(_media_only(classify_url(tgt)), rect)

            for sp in root.iter("{%s}sp" % NS["p"]):
                rect = _rect(sp, sw, sh)
                links = [sp.find("./p:nvSpPr/p:cNvPr/a:hlinkClick", NS)] + sp.findall(".//a:rPr/a:hlinkClick", NS)
                for click in links:
                    if click is not None and click.get(R + "id") in rels:
                        tgt, mode = rels[click.get(R + "id")]
                        if mode == "External":
                            add(_media_only(classify_url(tgt)), rect)
    return items


def _media_only(item: dict | None) -> dict | None:
    """Plain web links stay clickable in the PDF itself; only surface playable ones."""
    return item if item and item["k"] != "link" else None


def _publish_clip(z: zipfile.ZipFile, name: str, kind: str, out_dir: Path, url_prefix: str,
                  cache_dir: Path) -> dict | None:
    return publish_bytes(z.read(name), posixpath.basename(name), kind, out_dir, url_prefix, cache_dir)


def publish_bytes(data: bytes, name: str, kind: str, out_dir: Path, url_prefix: str,
                  cache_dir: Path) -> dict | None:
    """Copy a clip into the site (converting old formats) and describe it for the viewer."""
    ext = posixpath.splitext(name.lower())[1]
    if ext in AUDIO_WEB | AUDIO_OTHER:
        kind = "audio"
    elif ext in VIDEO_WEB | VIDEO_OTHER:
        kind = "video"
    digest = hashlib.sha256(data).hexdigest()[:16]
    out_dir.mkdir(parents=True, exist_ok=True)
    if ext in VIDEO_WEB | AUDIO_WEB:
        dest = out_dir / f"{digest}{ext}"
        dest.write_bytes(data)
    else:
        dest = _transcode(data, ext, kind, digest, out_dir, cache_dir)
        if dest is None:
            print(f"    ! {posixpath.basename(name)}: format not playable in browsers and ffmpeg is missing")
            return None
    return {"k": kind, "src": url_prefix + dest.name, "label": "Video" if kind == "video" else "Audio"}


def _transcode(data: bytes, ext: str, kind: str, digest: str, out_dir: Path, cache_dir: Path) -> Path | None:
    """Convert old formats (WMV, AVI, WMA…) to MP4 / MP3 once, cached by content."""
    target_ext = ".mp4" if kind == "video" else ".mp3"
    cached = cache_dir / "media" / f"{digest}{target_ext}"
    if not cached.exists():
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            return None
        cached.parent.mkdir(parents=True, exist_ok=True)
        src = cached.with_suffix(ext + ".src")
        src.write_bytes(data)
        args = ([ffmpeg, "-y", "-loglevel", "error", "-i", str(src)]
                + (["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart"] if kind == "video"
                   else ["-vn", "-c:a", "libmp3lame", "-q:a", "2"])
                + [str(cached)])
        try:
            subprocess.run(args, check=True, capture_output=True, timeout=1800)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            cached.unlink(missing_ok=True)
            return None
        finally:
            src.unlink(missing_ok=True)
    out_dir.mkdir(parents=True, exist_ok=True)
    dest = out_dir / cached.name
    shutil.copy2(cached, dest)
    return dest


# --------------------------------------------------------------------------- #
# PDF + metadata
# --------------------------------------------------------------------------- #

CLIP_NAME = re.compile(r"^(?:slide\s*)?(\d+)\s*[-_ .]", re.I)


def uploaded_clips(paths: list[Path], page_count: int, out_dir: Path, url_prefix: str,
                   cache_dir: Path) -> list[dict]:
    """Audio/video files uploaded for a quiz, named '<slide>-<anything>.<ext>'."""
    items = []
    for path in sorted(paths):
        m = CLIP_NAME.match(path.name)
        ext = path.suffix.lower()
        if not m or ext not in MEDIA_EXT:
            continue
        slide = int(m.group(1))
        if not 1 <= slide <= page_count:
            print(f"    ! {path.name}: slide {slide} doesn't exist")
            continue
        kind = "audio" if ext in AUDIO_WEB | AUDIO_OTHER else "video"
        item = publish_bytes(path.read_bytes(), path.name, kind, out_dir, url_prefix, cache_dir)
        if item:
            items.append({"s": slide, "r": None, **item})
    return items


def pdf_media(doc) -> list[dict]:
    """Link annotations (with positions) and bare media URLs in the text of a PDF."""
    items = []
    for num, page in enumerate(doc, 1):
        pw, ph = page.rect.width or 1, page.rect.height or 1
        seen = set()
        for link in page.get_links():
            uri = link.get("uri")
            item = classify_url(uri) if uri else None
            if not item or item["src"] in seen:
                continue
            seen.add(item["src"])
            r = link["from"]
            rect = [round(max(r.x0 / pw, 0), 4), round(max(r.y0 / ph, 0), 4),
                    round(min(r.width / pw, 1), 4), round(min(r.height / ph, 1), 4)]
            items.append({"s": num, "r": rect, **item})
        for m in MEDIA_URL_RE.finditer(page.get_text("text")):
            item = classify_url(m.group(0).rstrip(").,;"))
            if item and item["src"] not in seen and item["k"] != "link":
                seen.add(item["src"])
                items.append({"s": num, "r": None, **item})
    return items


def meta_media(entries, page_count: int) -> list[dict]:
    """Manually listed clips from the quiz's .yml: [{slide, url, start?}] or 'N: url' strings."""
    items = []
    for e in entries or []:
        if isinstance(e, str):
            m = re.match(r"^\s*(\d+)\s*[:\-–]\s*(\S+)", e)
            e = {"slide": int(m.group(1)), "url": m.group(2)} if m else {}
        if not isinstance(e, dict):
            continue
        try:
            slide = int(e.get("slide"))
        except (TypeError, ValueError):
            continue
        item = classify_url(str(e.get("url") or ""), _seconds(str(e["start"])) if e.get("start") else None)
        if item and 1 <= slide <= page_count:
            items.append({"s": slide, "r": None, **item})
    return items


def merge(*groups: list[dict]) -> list[dict]:
    """Combine sources; the first source to mention a clip on a slide wins, but a
    later source can supply the position if the first had none."""
    out: list[dict] = []
    index: dict[tuple[int, str], dict] = {}
    for group in groups:
        for it in group:
            key = (it["s"], unquote(it["src"]))
            if key in index:
                if index[key]["r"] is None and it["r"] is not None:
                    index[key]["r"] = it["r"]
                continue
            index[key] = it
            out.append(it)
    out.sort(key=lambda i: (i["s"], i["r"] is None, (i["r"] or [0, 0])[1], (i["r"] or [0, 0])[0]))
    return out
