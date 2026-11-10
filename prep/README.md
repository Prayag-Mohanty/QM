# Quiz Prep

Reading material for quizzers, shown on the site at `/askaban/prep/` (linked from the
**Quiz Prep** column on Askaban). Each resource is one Markdown file here; its address
is `/askaban/prep/<file name>/`, so a file's name should not change once it is shared.

```markdown
---
title: "Hotel Chains: Origins, Logos and Trivia"
category: Business            # must match a name in site.yml → prep_categories
group: "Brands and companies" # optional: a sub-heading inside the category
order: 1                      # optional: position inside its group (lower comes first)
updated: 2026-10-30           # optional: shown as "updated …"
summary: "One or two lines shown on the card and in search results."
---

## First section

Normal Markdown: headings, lists, **bold**, links and pipe tables all work.
Each `##` heading becomes an entry in the page's "On this page" list.

![Marriott logo](images/brand-marriott.png)
```

- Categories and their order live in `site.yml` under `prep_categories`. A category with
  no files yet shows as "coming soon", so SciTech, HELM, Sports, MELA and India are ready
  to fill.
- Pictures go in `prep/images/` and are referenced as `images/<file>`.
- Add `draft: true` to the front matter to keep a file off the site.
