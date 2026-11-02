# Text-to-speech source attribution

The service, CPU adapter and pinned asset manifest derive from ThreadShelf Local
Reader and Local Alternative by davoda1, used under the MIT license. Enhanced adds
owner-scoped queueing, HTTP streaming, private-session isolation, playback leases,
and an explicit transactional asset installer.

Application source does not include downloaded models, Python, wheels, engines or
Microsoft runtime binaries. Runtime downloads are selected by platform and engine
and verified against SHA-256 and byte counts in `cpu/assets-manifest.json`.
Installed distributions retain their notices and corresponding source archives.
Pocket code is MIT; its model is CC-BY-4.0 and voice-specific attribution applies.
Kokoro model/voices are Apache-2.0. Phonemizer and eSpeak NG are GPL-3.0; the pinned
corresponding sources are part of the Kokoro installation. See installed licenses.
