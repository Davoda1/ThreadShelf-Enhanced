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
After a successful repair, superseded installations are removed once active
speech workers release them. Failed or cancelled repairs preserve the previous
working installation.
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

## Settings previews and message playback

The **Local voices** installation and review controls appear only in
**Providers & voices**. Switching to Playback or another speech subtab preserves
provider drafts, reviewed download details and active installation progress;
return to Providers & voices to continue viewing those controls.

The Audio test button checks the current unsaved provider and voice; it does not
save preferences or cache the preview. Pocket and Kokoro testing remains disabled
until that specific engine is installed and verified. Checking, unavailable or
failed asset status cannot enable a CPU test. Installation, removal, returning to
settings and browser focus refresh this status. API previews remain available
without installing CPU models. Completed preview audio may still be replayed
without running the engine again.

Settings responses include access information for the web interface. The browser
keeps that metadata separate from outgoing settings, including audio previews and
credential-save rollback, while the server retains strict preference validation.
Message playback uses the same speaker SVG as Local Reader and Local Alternative,
with a fixed-size button and localized tooltip/accessibility labels.

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

By default, runtime installation, settings changes, credentials and cache management
require localhost. Existing archive and desktop-reader API access remain unchanged.

On a headless server, add `ALLOW_LAN_TTS=1` to the root `.env` beside
`setup-threadshelf.sh`, then restart the server. The normal LAN web address now
provides the full **Settings → Text-to-Speech** page and playback controls without
an API key. Enable speech, save, and explicitly review/download local voices there.
The flag itself neither enables speech nor downloads anything. It also permits
provider configuration, credential management and saved-audio access, just as
localhost does. `ALLOW_LAN_AI` is independent and is not required for speech.

Only `1` enables this override; `0`, unset or other values keep the default policy.
Changes require a restart, and an already exported environment variable takes
precedence over `.env`. `HOST`, `ALLOWED_HOSTS` and the browser Origin policy still
apply. This flag grants administration to clients that can reach the permitted
server address; it is neither authentication nor a private-subnet filter. Use it
only within a trusted network or an authenticated deployment boundary.

With `ALLOW_LAN_TTS=0`, the existing **Allow authenticated LAN speech** setting
provides restricted playback instead. It is off by default and requires enabled
speech, an enabled local model API and a configured nonempty `/v1` API key.
This mode uses installed local CPU voices, never the server's paid-provider
credentials. Its key stays in browser memory and server speech cache access is
disabled. Management remains localhost-only. The setting does not restrict the
full trusted-LAN access explicitly granted by `ALLOW_LAN_TTS=1`.

The flags do not enable the separate `/v1` network listener, change its configured
key policy, or unlock `/v1` on the main server port. See [Local model API](LOCAL_API.md#access).

The existing `/v1` inference boundary also exposes:

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

## Release 1.4.0 validation and sizes

The pinned initial downloads, including runtime/dependencies and license/source
payloads, are below. Previously verified downloads are reused; installing the
second engine shares downloads instead of fetching the common runtime twice.

| Server platform | Pocket only | Kokoro only | Both engines |
| --- | ---: | ---: | ---: |
| Linux x64 | 297,685,340 B | 454,030,643 B | 721,141,937 B |
| Windows x64 | 294,737,515 B | 438,103,613 B | 704,488,562 B |

The full fresh install reserves approximately 2.35 GB free space on Linux or
2.20 GB on Windows for downloads, staging and retained working files. This is a
conservative estimate, not a final installed size or a RAM requirement.

Windows support uses a pinned official Microsoft Visual Studio CRT VSIX. The
installer extracts only the twelve redistributable release DLLs, verifies each
against its independent hash, and places them inside the speech runtime and
Pocket directory. It never executes a system installer or requires administrator
rights. Microsoft redistribution terms are retained with the installed voices.

The release validation on Linux x64 performed a real fresh on-demand download,
verified all pins, synthesized with all six Pocket voices and three Kokoro
representative voices, and checked a long path containing Unicode, spaces and an
apostrophe. Real streaming tests compared streamed PCM with the completed WAV,
confirmed cancellation after the first chunk and the nonstreamed path, and
verified temporary file cleanup. A real transfer was cancelled after 12,572,778
bytes and resumed from that exact offset; the cancelled attempt was never Ready.

Real HTTP tests exercised both engines through the new server routes with
streaming on/off, private synthesis and optional saved audio. They moved the
installed asset/profile directory before starting the server, verified both
engines still worked, and checked the compatible `/v1/audio/speech` PCM stream,
selected voice, model discovery and all 34 voice IDs. These tests used synthetic
text and isolated data directories, not a live personal conversation database.

Windows archive download, member selection and all 24 destination DLL hashes
were verified on Linux, with synthetic extraction and failure regressions.
Windows native execution has not been exercised in this Linux environment.
External paid providers have deterministic transport regressions; no paid account
or live paid inference was used during validation.
