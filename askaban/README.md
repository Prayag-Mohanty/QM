# Askaban

Twitter-style updates from quiz events, newest first, at `/askaban/`.
The easiest way to post is the **Askaban** tab on the site's Manage page (`/upload/`).

Each post is one Markdown file here, named by date and time:

```markdown
---
date: "2026-10-26 18:30"
event: "Techfest Open Quiz, IIT Bombay"
place: "Mumbai"
result: "Winner"
scores: ["*Brandish Bandits: 92", "Team Quark: 86", "Mind Benders: 71"]
photos: ["images/finals.jpg", "images/cheque.jpg"]
tags: ["Techfest", "IITB"]
---
What a final. Won it on the very last question!
```

- Everything except `date` is optional; a post can be just text, just photos, or a full scorecard.
- `result`: "Winner", "Runner-up" and "3rd" get a gold, silver or bronze medal card.
- `scores`: one team per line in finishing order; start your team's line with `*` to highlight it.
- Photos go in `askaban/images/` (resized automatically). Up to 4 show in the post; more appear as "+N" and open in the viewer.
