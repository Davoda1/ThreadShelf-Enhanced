# Server patch attribution

Original patcher, extension and suite integration work:
**Copyright (c) 2026 davoda1**, MIT; see `LICENSE`.

The extension integrates with and reuses interfaces and behavior from
[ThreadShelf](https://github.com/ChrystianSchutz/ThreadShelf),
**Copyright (c) 2026 Chrystian Schutz**, MIT. The exact reviewed base is tag
`v1.3.0`, commit `3430dd04f50218fdea916b104709d24a651017fc`.
The upstream license is reproduced in `ThreadShelf-LICENSE.txt`. The unified diff retains
small upstream context passages; the complete upstream server is not bundled.

The installed server supplies Express, LanceDB, the embedding pipeline and their
transitive dependencies under their own licenses. This patch adds no runtime
dependency and does not redistribute those dependency binaries. Consult the
upstream package lockfile and notices when building or distributing the server.

ThreadShelf Local Suite is an independent companion project, not a fork or an
official ThreadShelf release. No upstream endorsement is implied.
