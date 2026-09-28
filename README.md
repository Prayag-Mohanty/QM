<div align="center">

# QM Prayag

**Home of quiz sets written, hosted or attended by Prayag Mohanty.**

A personalised alternative to slideshare. Flip through them slide by slide, download the originals, share them with your quiz club.

**[prayag-mohanty.github.io/QM](https://prayag-mohanty.github.io/QM/)**

</div>

---

## The story

For years, these quiz sets lived on SlideShare. Then the quality dropped, the
ads piled up, and uploads stopped working. So: *screw it*. This is their new
home — no ads, no logins, no paywall. Just quizzes.

## What it does

- **SlideShare-style viewer** — arrow keys, swipe, full screen, and links that
  jump straight to a slide (`…/#slide-12`).
- **Audio & video that actually plays** — the thing SlideShare never did.
  Clips embedded in a PowerPoint, YouTube / Spotify / Drive links, or plain
  MP4s get a ▶ button right on the slide they belong to.
- **Download the originals** — PDF and PPTX, untouched.
- **Share anywhere** — WhatsApp, Telegram, X, LinkedIn, email, or embed the
  viewer on another site.
- **Easy to find** — every slide's text is on the page, so Google, Bing and AI
  assistants can read the questions (and, fair warning, the answers).
- **Light & dark mode**, and it works nicely on phones.

## Publishing a quiz

Everything happens on the site's **Manage** page (`/QM/upload/`) — no code,
no command line.

1. **Upload** the PDF, the PPTX, or both (same deck → one quiz).
2. **Add details** — title, date, event, quizmaster, topics.
3. **Add clips** if any — upload MP4 / MP3 files or paste links, with the slide
   number they belong on.
4. **Publish.** The site rebuilds itself and the quiz is live in a minute or two.

Editing, renaming, swapping files, moving clips to another slide, or deleting
a quiz all live on the same page. A quiz's web address never changes, so
shared links keep working.

> **Tip for Canva / Google Slides decks:** upload the **PDF and the PPTX**
> together. The PDF is shown pixel-perfect; the audio and video are pulled
> from the PPTX and matched to the right slides automatically.

The finer points — file naming, size limits, clip formats — are in
[`quizzes/README.md`](quizzes/README.md).

## Under the hood

A small, static site: no server, no database, nothing to keep running.

| Piece | Job |
|---|---|
| `quizzes/` | The quiz files and their details (`.yml`). This *is* the database. |
| `build.py` | Turns them into the website: converts PPTX → PDF (LibreOffice, with the deck's own fonts), pulls out slide text and covers. |
| `media.py` | Finds audio & video in decks and links, and matches PPTX slides to PDF pages. |
| `templates/`, `assets/` | Page layouts, styles and the slide viewer ([PDF.js](https://mozilla.github.io/pdf.js/)). |
| `site.yml` | Site name, links, contact and search-engine settings. |
| GitHub Actions | Rebuilds and publishes on every change, then pings Bing & co. via IndexNow. |

Preview locally:

```bash
pip install -r requirements.txt     # plus LibreOffice for PPTX files
python build.py --serve             # → http://localhost:8000
```

## Say hi

Bricks & bouquets welcome —
[Instagram](https://www.instagram.com/praymo_o/) ·
[LinkedIn](https://www.linkedin.com/in/prayag-mohanty/) ·
[topper1728@gmail.com](mailto:topper1728@gmail.com)

Free to use for quizzing. Please credit the quizmaster when you use the questions.
