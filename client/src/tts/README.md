# Browser speech integration

The queued Web Audio player and provider/cache/credential controls are adapted from
ThreadShelf Local Reader and Local Alternative. `READER-LICENSE.txt` preserves its MIT license; the controller
also retains the Lucide icon notice. CPU model and runtime licenses are handled by
the separate server asset installer.

`runtime.tsx` owns one player per browser tab. `transport.ts` provides a same-origin,
bounded NDJSON bridge to the server, with an in-memory random owner identity and,
for explicitly enabled LAN speech, an in-memory bearer key. Neither is put into
browser storage or URLs. The player never replays the final complete audio after
already consuming its streamed clips, and renews playback protection for paused
as well as playing completed recordings.

`ReadAloud` receives the full original turn, independently of lazy rendering,
collapsed previews, search highlighting and theme. `speech.ts` extracts the speech
text without executing HTML, and fingerprints the full normalized message before
filtering code or citations. A tested SHA-256 fallback supports ordinary HTTP LAN
origins that do not expose `crypto.subtle`. Normalized turn identities and archive
source tuples are never rewritten by speech functionality.

The React settings mount retains the Reader's settings, discovery, preview,
credentials and cache controls while adding explicit reviewed installation of local
voice packs. Main application settings remain three tabs. Localized controller
chrome tracks its original application text; it excludes entered passages, voice
and model identifiers, provenance and cache source paths from translation.

Validation: `test/tts-browser-speech.test.js`, `test/playwright/tts.spec.js`, the
server TTS tests, and the application-wide locale, type, lint and browser gates.
