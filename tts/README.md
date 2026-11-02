# ThreadShelf Enhanced Text-to-Speech

Text-to-speech is disabled by default. Enabling it exposes the reading controls;
it never downloads models automatically. In **Settings → Text-to-Speech**, review
**Download local voices** to install Pocket, Kokoro, or both on the server. The
source package contains the service and installer, not model weights or runtimes.

The download review resolves the exact platform, hashes, sizes, engine revisions,
licenses and a conservative free-space estimate. The server downloads missing
files into `.threadshelf/tts/assets/downloads`, verifies SHA-256 and size, expands
them into a private staging directory, generates a short offline readiness
sample, hashes the complete installed tree, then atomically activates the result.
Cancellation never publishes an incomplete installation. Verified downloads and
partial files can be reused on retry. Download again to repair an installation.
Missing or damaged local voices do not stop archive startup or API speech.

Both engines run on CPU with a project-local Python and pinned dependencies:

- Pocket TTS English 2026-10: 100M, six preset voices, default `alba`.
- Kokoro 82M v1.0 FP32 ONNX: 28 English voices, default `am_michael`.

Linux x64 and Windows x64 have pinned payloads. Other platforms can use a speech
API. These particular local voice packs support English; they do not promise
Hungarian synthesis. Model file size is not a statement of peak RAM consumption.

All TTS settings, encrypted credentials, optional saved audio, downloads and
installed voices live below `.threadshelf/tts` (or `tts` in an explicit server
data directory). Migrating the whole `.threadshelf` directory preserves them.
Disabling TTS keeps installed voices and existing saved audio. Explicit removal
of an engine preserves the other engine, settings and audio recordings.

## Providers and playback

Pocket and Kokoro run offline after installation. Self-hosted HTTP(S), ElevenLabs,
OpenRouter speech and OpenAI Realtime are explicit opt-in API providers. No paid
provider is a fallback. API keys can be held for the server session or saved with
AES-256-GCM and a passphrase-derived scrypt key; saved keys are locked on restart.
The passphrase is never saved. Never include provider credentials in a URL.

Streaming has a separate on/off switch. Turning it off waits for the complete
recording. Streaming validates playable audio chunks before delivery; it does not
invent word timing. Paused playback remains protected from cache cleanup.

Disk caching is off by default. With it on, compatible completed recordings are
selected in this order: pinned, preferred saved API recording, exact synthesis,
then a fresh generation. Full-message and spoken-content fingerprints prevent
reuse after text changes. Pinned recordings are not overwritten by regeneration.
The RAM cache has a three-recording limit and a selectable 32–256 MiB bound.
Private chats do not read saved recordings or retain generated audio in either
cache. Temporary CPU working files are removed on completion or cancellation.

The server uses a bounded eight-job FIFO (at most two outstanding jobs per tab).
Starting speech in one tab does not cancel another tab's request. Cancellation
uses the owning tab's random session identity. Playback leases are renewed while
playing or paused and expire after five minutes without a heartbeat.

## Network boundary

Runtime installation, settings changes, credentials and cache management require
localhost. Existing archive and desktop-reader API access remain unchanged.
Authenticated LAN speech is a separate setting, off by default, and additionally
requires a configured nonempty local `/v1` API key. LAN web playback is limited to
installed local CPU voices, never the server's paid-provider credentials. Its key
is held in browser memory only; server speech cache access is disabled for it.

The existing keyed `/v1` inference boundary also exposes:

- `GET /v1/models`: installed `tts-pocket` and `tts-kokoro` when TTS is enabled.
- `GET /v1/audio/voices`: available English voice IDs and their model IDs.
- `POST /v1/audio/speech`: `model`, `input`, `voice`, and `response_format` (`wav`
  or raw 24 kHz mono signed 16-bit PCM). `speed` must be 1; change playback speed
  in the consuming player. These calls are not archived or cached.

Desktop GUIs can configure this endpoint as their existing self-hosted provider.
They do not need a database migration or an automatic provider switch.

## Validation

The normal test suite includes the original service/provider/cache/credential
regressions and server queue, private-mode, archive extraction and transactional
installer regressions. Real engines can be checked after explicit installation:

```sh
node tts/cpu/test_cpu.cjs --assets /absolute/path/to/active/version
node tts/cpu/test_cpu_streaming.cjs --assets /absolute/path/to/active/version
```

See `ATTRIBUTION.md`, retained license texts and the installed model notices.
