# Blog

Each story is one Markdown file in this folder, e.g. `the-night-we-won-by-half-a-point.md`.
The easiest way to write one is the **Blog** tab on the site's Manage page (`/upload/`).

```markdown
---
title: "The night we won by half a point"
date: 2026-10-26
summary: "One or two sentences — shown on the blog page and on Google."
tags: ["Stories", "BITS Goa"]
cover: images/winning-moment.jpg
---

Write the story here. Leave an empty line between paragraphs.

![The scoreboard at the end](images/scoreboard.jpg)
*The scoreboard at the end — a caption in italics right below a photo.*

## A subheading

**Bold**, *italic*, > quotes and - bullet lists all work.
```

- Photos go in `blog/images/`. Big phone photos are fine; the site resizes them.
- `summary`, `tags` and `cover` are optional. Without a cover, the first photo in the story is used.
- Add `draft: true` to keep a story off the site while you work on it.
