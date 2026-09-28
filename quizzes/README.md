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

## Size limits

The website's Manage page handles files up to 300 MB: anything over 15 MB is
saved in parts (`Name.pptx.part01`, `part02`…) and the site joins them back
into one file, so visitors see and download it normally. Uploading straight to
GitHub in the browser is limited to 25 MB per file.
