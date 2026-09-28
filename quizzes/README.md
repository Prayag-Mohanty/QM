# Put your quiz files here

Drop quiz sets into this folder and push to `main` — the site rebuilds itself
in a couple of minutes.

**Supported:** `.pdf`, `.pptx`, `.ppt`, `.ppsx`, `.odp`, `.docx`

## Easiest: the website's upload page

Go to `/upload/` on the site (footer → Upload). It saves files here for you.

## Or upload on GitHub

1. Open <https://github.com/Prayag-Mohanty/QM/upload/main/quizzes>
2. Drag your PDF / PPTX files in.
3. Click **Commit changes**. Done — watch progress under the **Actions** tab.

## Naming

The file name becomes the page title and web address, so name files nicely:
`Sci-Tech Quiz - Quark 2024 Prelims.pptx` → “Sci-Tech Quiz - Quark 2024 Prelims”
at `/quiz/sci-tech-quiz-quark-2024-prelims/`.

## PDF + PPTX of the same quiz

Upload both with the same name (`Biz Quiz 2024.pdf` and `Biz Quiz 2024.pptx`).
They become one quiz page: the PDF is shown in the viewer (pixel-perfect,
your exact fonts) and both are offered for download. With only a PPTX, the site
converts it to PDF for you (fonts may differ slightly from PowerPoint).

## Optional details (recommended for Google)

Add a text file with the **same name** ending in `.yml`, e.g. `Biz Quiz 2024.yml`:

```yaml
title: Biz Quiz 2024 — Finals
description: Finals of the inter-college business quiz — brands, logos, startups and ads.
date: 2024-02-18
tags: [Business, Brands, India]
event: Waves 2024, BITS Goa
quizmaster: Prayag Mohanty
notes: |
  Anything else you want to say about the quiz (Markdown is fine).
```

Every line is optional. Without a `date`, the upload date is used.

## Audio & video questions

Slides with audio or video get a ▶ play button right where the clip sits on
the slide; it plays in place and stops when you move to another slide.

- **Clips embedded in a PowerPoint** (Insert → Video/Audio) are extracted
  automatically from the `.pptx`. Old formats (WMV, AVI, WMA…) are converted
  to MP4/MP3 during the build.
- **Links on slides** to YouTube, Vimeo, Google Drive, Spotify, SoundCloud or
  a direct `.mp3`/`.mp4` file become in-slide players (from the PPTX, or from
  clickable links in a PDF). A YouTube link's `?t=42` start time is kept.
- **Video or audio files** (an `.mp4`, `.mp3`, `.m4a`…): on the Manage page,
  under *Audio / video files*, pick the file and type the slide number it plays
  on. It's saved as `quizzes/<quiz name>.media/<slide>-<file name>` and gets a
  ▶ play button on that slide. Large files go up in parts automatically.
- **Links to anything else** (e.g. a clip you played from your laptop): add it in the
  Manage page's *Audio / video links* box as `12: https://youtu.be/…`, or in
  the `.yml`:

  ```yaml
  media: [{"slide": 12, "url": "https://youtu.be/dQw4w9WgXcQ", "start": "0:42"}]
  ```

Tip: upload the **PDF and the PPTX** of the same deck (same file name). The
PDF is shown pixel-perfect, and the clips are taken from the PPTX. Big decks
with videos are fine — uploads over 15 MB go up in parts.

## Size limits

The website's Manage page handles files up to 300 MB: anything over 15 MB is
saved in parts (`Name.pptx.part01`, `part02`…) and the site joins them back
into one file, so visitors see and download it normally. Uploading straight to
GitHub in the browser is limited to 25 MB per file.

## About-page photos

**Few at a time:** Manage page → **About photos** → pick or drag in several photos at once, type captions, choose the main photo, **Save photos**.

**Lots at once:** on GitHub open `pages/gallery/` → **Add file → Upload files** → drag in the whole batch → **Commit changes**. Every photo in that folder appears on the About page, after the ones already arranged.
- Name the files after their caption (e.g. `Winners - Quark 2023, BITS Goa.jpg`) and that becomes the caption. Camera names such as `IMG_2031.jpg` get no caption.
- Big phone photos are fine; the site resizes them. iPhone HEIC photos need to be JPG.
- Captions, order and the main photo can be changed any time in the **About photos** tab.
- The main photo sits beside the About text, cropped to a portrait frame around the centre. To shift the crop, add `"focus": "30% 20%"` (left–right, top–bottom) to that photo in `pages/gallery.json`.
