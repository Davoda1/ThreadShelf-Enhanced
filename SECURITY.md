# Security and privacy

ThreadShelf Enhanced is designed for local archives. Its main search path uses
local embeddings and LanceDB; it does not require a cloud vector database or an
external embedding API.

## Protect archive data

Keep real chat exports, uploaded sources, `.env`, databases, `.collections.json`,
`.threadshelf/`, logs, temporary folders and screenshots of conversations out of
source control. Committed fixtures must be synthetic and anonymized. Back up
archive data before upgrades or migrations.

## Server exposure

The supplied configuration binds the server to `127.0.0.1`. Keep this default for
single-machine use. You can set it explicitly in `.env`:

```dotenv
HOST=127.0.0.1
PORT=3000
```

`HOST=0.0.0.0` allows network access to the archive API. `ALLOWED_HOSTS` validates
request hosts; it is not user authentication. Use a trusted network boundary or
an authenticated reverse proxy before enabling remote access. The browser UI uses
same-origin requests and does not enable cross-origin access by default.

The optional model API has separate access settings; its API key does not add
authentication to the archive UI/API.

## Imports and rendering

Imported HTML is parsed as data rather than executed. Local media resolution is
limited to supported raster images under the selected source or ZIP and rejects
unsafe paths and content. Remote images load only after an explicit click.
Unsupported rich content remains readable source or an inert placeholder.

Retain original exports: normalization cannot represent every future format or
attachment. Do not use live exports in public bug reports.

## Generation and MCP

Managed `llama-server` processes bind to an ephemeral loopback port. Configured
llama.cpp URLs must be loopback-only, and GGUF files must be under configured
model roots.

OpenRouter is an explicit external integration. Sending a continuation transmits
the selected thread's user/assistant turns and prompt to OpenRouter and its
routed provider; archived thinking is excluded. The UI labels this provider as
external. Optional routing and data-collection controls do not make the request
local.

Prefer `OPENROUTER_API_KEY`. Keys entered in Settings remain in process memory;
they are not returned by the API or persisted in generation configuration.

The MCP server gives connected clients access to indexed local chat data. Configure
it only in clients you trust. Initial dependency, runtime and model downloads use
external services even when subsequent search and generation run locally.

## Reporting a vulnerability

Use [GitHub's private vulnerability reporting](https://github.com/Davoda1/ThreadShelf-Enhanced/security/advisories/new)
if it is enabled for this repository. If unavailable, open an
[issue](https://github.com/Davoda1/ThreadShelf-Enhanced/issues) requesting a private
reporting channel, without publishing exploit details or sensitive data.

Provide affected versions, routes or tools, reproduction steps and a synthetic
example. Never include credentials or real conversation exports. General bugs
that do not expose a vulnerability can be reported in ordinary issues.

## Dependencies

The application uses Express, Multer, LanceDB, Transformers.js and bundled browser
rendering libraries. Review dependency changes and retained licenses before a
release. Exact dependency versions are recorded in `package-lock.json`.
