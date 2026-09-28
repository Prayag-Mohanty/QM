# QM Prayag

A simple, fast, free-to-host website for Prayag Mohanty's quiz sets — a
SlideShare replacement you own.

- **View** every quiz slide by slide in the browser (keyboard arrows, swipe,
  full screen, deep links to a slide like `…/#slide-12`).
- **Download** the original PPTX and/or PDF.
- **Share** via WhatsApp, Telegram, X, Facebook, LinkedIn, email, the phone's
  share sheet, or embed the viewer on any website with an `<iframe>`.
- **Found by Google, Bing and AI assistants**: every slide's text is on the
  page, plus structured data (schema.org `Quiz`), sitemap, RSS feed,
  `llms.txt` / `llms-full.txt`, a Markdown copy of every quiz and a
  `quizzes.json` index.

## Adding a quiz

Upload PDF/PPTX files into [`quizzes/`](quizzes/) on the `main` branch — from
the browser at <https://github.com/Prayag-Mohanty/QM/upload/main/quizzes>.
The site rebuilds automatically. See [`quizzes/README.md`](quizzes/README.md)
for naming, tags, dates and descriptions.

## One-time setup

1. Merge this branch into `main`.
2. In the repo go to **Settings → Pages → Build and deployment → Source** and
   choose **GitHub Actions**.
3. Push anything to `main` (or run the workflow from the **Actions** tab).
   The site goes live at **https://prayag-mohanty.github.io/QM/**.

### Getting found on Google & Bing

1. Add the site in [Google Search Console](https://search.google.com/search-console)
   (URL-prefix property), paste the verification code into `site.yml`
   (`google_site_verification`), push, then submit `sitemap.xml`.
2. Do the same in [Bing Webmaster Tools](https://www.bing.com/webmasters)
   (`bing_site_verification`) — Bing also feeds ChatGPT search, Copilot and
   DuckDuckGo.
3. Link to the site from your social profiles, old SlideShare decks and quiz
   club pages — links are what get a new site crawled quickly.

### Custom domain (optional, recommended)

Buy a domain (e.g. `qmprayag.com`), set `url: https://qmprayag.com` in
`site.yml`, point the domain's DNS at GitHub Pages
([instructions](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site)),
and enter it under **Settings → Pages → Custom domain**. A custom domain also
makes `robots.txt` apply to the whole site.

## Editing the site

| What | Where |
| --- | --- |
| Site name, tagline, description, social links | `site.yml` |
| About page | `pages/about.md` |
| Look & feel | `assets/style.css` |
| Page layouts | `templates/` |

## Preview locally (optional)

```bash
pip install -r requirements.txt   # plus LibreOffice for PPTX files
python build.py --serve           # http://localhost:8000
```

## How it works

`build.py` groups files in `quizzes/` by name, converts PowerPoint/Word files
to PDF with LibreOffice, extracts each slide's text and a cover image with
PyMuPDF, and writes a static site to `_site/`. The GitHub Actions workflow in
`.github/workflows/deploy.yml` runs it on every push to `main` and publishes to
GitHub Pages. Converted files are cached, so rebuilds stay quick as the
collection grows. The slide viewer uses a bundled copy of
[PDF.js](https://mozilla.github.io/pdf.js/) (`assets/pdfjs/`, Apache-2.0).
