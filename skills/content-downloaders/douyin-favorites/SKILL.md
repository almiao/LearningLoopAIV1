---
name: douyin-favorites
description: Download, open, transcribe, and archive Douyin saved/favorite videos into Markdown using the logged-in Douyin desktop app and desktop automation. Use when the user asks to export, download, play, transcribe, summarize, or archive recent Douyin favorites, saved videos, collected videos, or direct Douyin video URLs; if the app is not logged in, ask the user to log in to Douyin first and rerun.
---

# Douyin Favorites

## Workflow

1. Use the logged-in Douyin desktop app first. Activate `/Applications/抖音.app`; do not copy browser profiles or inspect login stores.
2. Prefer Computer Use when available: click the left sidebar `我的`, click the profile `收藏` tab, open the first visible collected video, and start playback.
3. If Computer Use is unavailable, use macOS desktop automation only for clicks and screenshots. Treat coordinates as layout-dependent and verify with screenshots or user-visible feedback.
4. Extract text in this order: visible in-video subtitles, page description/title/hashtags, then true ASR from the video/audio if local ASR tooling is available.
5. If no subtitle text or ASR is available, write a Markdown record that clearly says transcription is pending. Do not pretend visible page text is a full speech transcript.
6. If the app shows a login gate, ask the user to log in to the Douyin desktop app and rerun. Never ask for cookies, tokens, passwords, QR contents, Keychain values, or copied local storage.

## Script

Run `scripts/export-favorite.mjs` when Node.js is available. It uses only desktop app activation, optional mouse clicks, screenshots, and user/ASR-provided transcript text.

Environment variables:

- `DOUYIN_OUTPUT`: Markdown output path. Default: `downloads/douyin/favorite-video.md`.
- `DOUYIN_CLICK_SEQUENCE`: Set to `latest-favorite` to click `我的` -> `收藏` -> first card using desktop coordinates.
- `DOUYIN_SCREENSHOT_DIR`: Screenshot evidence directory. Default: `downloads/douyin/screenshots`.
- `DOUYIN_TRANSCRIPT_FILE`: Optional local transcript text file to embed.
- `DOUYIN_TRANSCRIPT_TEXT`: Optional transcript text to embed directly.
- `DOUYIN_TITLE`: Optional video title for the Markdown heading.
- `DOUYIN_AUTHOR`: Optional author name.
- `DOUYIN_VIDEO_URL`: Optional sanitized source URL for the Markdown metadata.

Example:

```bash
DOUYIN_OUTPUT="downloads/douyin/latest-favorite.md" \
DOUYIN_CLICK_SEQUENCE="latest-favorite" \
node skills/content-downloaders/douyin-favorites/scripts/export-favorite.mjs
```

## Login Handling

If the desktop app is logged out, ask the user to open the installed Douyin app and log in. Then rerun the same command. Do not ask for cookies, session tokens, passwords, QR contents, Keychain values, or copied local storage.

## Extraction Notes

- Prefer clicking visible UI over private APIs.
- Use direct video URLs only when the user provides them or they are visible in the app/browser UI.
- Sanitize all output URLs by removing query strings and hashes.
- Page-visible text is not always a full speech transcript. Label it honestly as visible description/subtitle text unless an ASR pass was actually run.
- Do not use Cookie/Token/Keychain decryption or profile-copy login transfer as part of this skill.

## Verification

Before reporting completion:

- Re-read the generated Markdown file.
- Confirm no output URL contains query tokens.
- Confirm whether the result is a visible-text record or a true ASR transcript.
- Confirm screenshots show the intended video when screen capture works.
- Confirm no login secrets were read or written.
