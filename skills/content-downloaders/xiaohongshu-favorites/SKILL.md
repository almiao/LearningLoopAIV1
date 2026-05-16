---
name: xiaohongshu-favorites
description: Download Xiaohongshu/XHS saved favorite notes or direct note pages into Markdown using a logged-in local Chrome session and Playwright CDP. Use when the user asks to export, download, archive, summarize, or convert Xiaohongshu favorites, collections, saved posts, or note URLs into Markdown; if the browser is not logged in, ask the user to log in to Xiaohongshu in Chrome and rerun.
---

# Xiaohongshu Favorites

## Workflow

1. Use a real local Chrome session path. Plain headless Playwright commonly hits Xiaohongshu login or risk checks.
2. Copy the local Chrome profile into a temporary directory before automation. Do not mutate the user's live profile.
3. Launch an independent Chrome instance with `--remote-debugging-port`, then connect with Playwright `chromium.connectOverCDP`.
4. If a direct note URL is provided, open it. Otherwise open the supplied profile URL, or open Xiaohongshu home and follow the logged-in `我` link to the profile page.
5. Click the visible top-level `收藏` tab, then choose a visible `a.title` card in the active `笔记` collection.
6. Open the selected note and extract title, author, date/location, comment line, body text, tags, and image links.
7. Write a Markdown artifact with sanitized source URLs. Do not preserve `xsec_token`, query strings, cookies, or local profile paths in output.
8. Clean up the temporary Chrome profile and any remote-debug Chrome process.

## Script

Run `scripts/export-favorite.mjs` when Node.js and Playwright are available.

Environment variables:

- `XHS_NOTE_URL`: Direct Xiaohongshu note URL to export. Optional.
- `XHS_PROFILE_URL`: Xiaohongshu profile URL. Optional if `XHS_NOTE_URL` is set or the logged-in `我` link can be discovered.
- `XHS_NOTE_QUERY`: Text to match in the favorite grid. Optional; defaults to the first visible favorite note.
- `XHS_OUTPUT`: Markdown output path. Default: `downloads/xiaohongshu/favorite.md`.
- `XHS_CDP_PORT`: Remote debugging port. Default: `9224`.
- `XHS_CHROME_PROFILE`: Chrome profile root. Default: `~/Library/Application Support/Google/Chrome`.

Example:

```bash
XHS_NOTE_QUERY="AI Agent" \
XHS_OUTPUT="downloads/xiaohongshu/ai-agent.md" \
node skills/content-downloaders/xiaohongshu-favorites/scripts/export-favorite.mjs
```

## Login Handling

If extraction cannot find the logged-in profile link or the `收藏` tab, treat the session as not logged in or blocked. Ask the user to log in to Xiaohongshu in normal Chrome, then rerun the script. Do not ask for cookies, tokens, or password text.

## Extraction Notes

- Prefer the smallest visible matching card node. Broad ancestors can contain every card title and navigate incorrectly.
- A good favorite candidate is usually a visible `a.title` with nonzero width/height and an `href` pointing to a note.
- Detail pages may normalize profile-note URLs into `/explore/<note-id>`.
- Filter legal/footer/sidebar text out of the final Markdown.
- Keep output useful for recall and research by default. Include direct full text only when the user asks for archival output and has access to the page.

## Verification

Before reporting completion:

- Re-read the generated Markdown file.
- Confirm the title matches the selected note.
- Confirm source links in Markdown do not contain `xsec_token` or other query parameters.
- Confirm temporary Chrome processes and temp profiles were cleaned up.
