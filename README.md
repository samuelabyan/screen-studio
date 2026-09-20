# Screen Studio - Local Screen Recorder

[Screen Studio](https://samuelabyan.github.io/screen-studio) is a screen recorder and trimmer that lives in a single HTML file. Open it in your browser and record your screen, your camera and your voice, cut the clip, and save it — no install, no build step, no server, no account. Nothing ever leaves your machine: the file has no network calls at all, and the video is held in memory until you save it.

## Features

- **Record a screen, a single app window, or a browser tab** — picked through the browser's own sharing dialog
- **Camera overlay** with adjustable size, circle or rounded shape, mirroring, an optional ring and shadow, nine position presets, and free drag-and-drop placement in the live preview
- **Three capture modes** — screen only, screen with camera, or camera only
- **Microphone and computer/tab audio** as separate switches, with a live input level meter
- **Built-in trimmer** — drag handles or set in/out points at the playhead, preview the cut, then export
- **Two ways to save** — the full recording instantly, or a re-encoded trimmed cut
- **Quality controls** — resolution up to the source, 15–60 fps, three bitrate presets, MP4 or WebM where the browser supports it
- **Countdown, pause and resume**, a running timer and file size, plus keyboard shortcuts for everything
- **Background-safe capture** — frames are driven off the audio clock, so the recording doesn't stall when you switch to the app you're demonstrating
- **Settings persist** between sessions

## Shortcuts

| Key | Action |
| --- | --- |
| `R` | Start or stop recording |
| `Space` | Pause and resume (play/pause in the editor) |
| `M` | Mute the microphone |
| `C` | Show or hide the camera |
| `I` / `O` | Set the trim start / end |
| `←` `→` | Nudge a second (hold `Shift` for five) |

## Notes

- Works in Chrome, Edge, Firefox and Opera. Safari needs the file served over HTTPS rather than opened directly.
- Computer audio is only captured if you tick the audio box inside the browser's sharing dialog. On Windows that option appears for a whole screen or a tab, not for a single window.
- Trimming re-encodes in real time, so a two-minute cut takes about two minutes. Saving the untrimmed recording is instant.

## License

MIT
