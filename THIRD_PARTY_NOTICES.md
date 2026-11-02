# Third-party notices

ThreadShelf Enhanced is derived from ThreadShelf v1.3.0, commit
3430dd04f50218fdea916b104709d24a651017fc, by Chrystian Schutz and contributors.
The original MIT license is retained in LICENSE. Enhanced is a distinct fork;
upstream has not endorsed or published this release.

Enhanced modifications: Copyright (c) 2026 davoda1, licensed under the same MIT
terms in LICENSE. This supplements the original upstream copyright.

Import and rendering adaptations derive from the supplied ThreadShelf Local
Reader 3.3.0 revision 9 by davoda1 (MIT). That implementation's published API
counterpart is ThreadShelf Local Suite v1.0.0 at commit
e17d5874342ce0069acba2ed387d46eefbf61f24. Attribution and full original licenses
are retained in src/enhanced-import/vendor/ and
client/src/enhanced-renderer/licenses/; component-specific notes are adjacent.

The integrated Reader pagination extension and test client adapters derive from
ThreadShelf Local Suite. See test/fixtures/compatibility-clients/README.md
and PAGINATION-NOTICES.md plus the retained MIT LICENSE in that directory.

ChatGPT Export Processor GUI 1.1.0 was used as a format and behavior reference.
Original export files are not modified by this application.

Bundled browser assets include MathJax (Apache-2.0) and Mermaid (MIT). Marked,
highlight.js, and other dependencies retain their respective license files.
The lockfile specifies exact installed dependency versions. Refer to
client/src/enhanced-renderer/ATTRIBUTION.md for asset provenance.

Complete bundled-library license texts and exact-version provenance are indexed
in [Bundled asset notices](client/src/enhanced-renderer/licenses/BUNDLED-ASSET-NOTICES.md).

The Enhanced 1.4.0 live-vault, tool-streaming, Strata and vision adaptations also
use ThreadShelf v1.4.1, commit d8e59473e465180fcdd7d690cfb61b35c00a6efe (MIT).
They retain the upstream license above and the fork's independent storage design.

The server speech service and browser controls derive from ThreadShelf Local Reader
and Local Alternative (MIT). See `tts/ATTRIBUTION.md`
and adjacent retained licenses. Optional downloaded models/runtime components
have their own licenses and notices; they are not all MIT. Pocket model/voice
notices, Kokoro Apache-2.0 and GPL eSpeak/phonemizer corresponding sources remain
part of the reviewed optional asset install, not the application source archive.
