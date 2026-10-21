# Bundled asset provenance

The browser assets were adapted from ThreadShelf Local Reader by davoda1.
They were verified byte-for-byte against the official npm releases below. No
browser asset was modified during attribution preparation.

| Bundled file | Bytes | SHA-256 | Official source file |
| --- | ---: | --- | --- |
| `mermaid.min.js` | 3572661 | `581ed7d74bd9048d0e3a91363927d72ef22942d7722546b27f7cc29e35390eb8` | [package/dist/mermaid.min.js](https://registry.npmjs.org/mermaid/-/mermaid-11.17.2.tgz) |
| `mathjax-tex-svg.js` | 2108580 | `0383da4c22a61555f3d99877f939f00012d2583381177302987ab04760cdadf3` | [package/es5/tex-svg.js](https://registry.npmjs.org/mathjax/-/mathjax-3.2.1.tgz) |

The exact Mermaid npm archive supplies `package/dist/mermaid.min.js.map`.
Its SHA-256 is `43cd977e8e0f351d6c47d31302c564f1c21fdc1e0be0d9e46370ee5e23cea004`.
The map records the direct dependency package versions in its pnpm source paths.
[Additional nested bundle checks](NESTED-BUNDLE-PROVENANCE.md) resolve the bundled
parser, Rough.js and Venn inputs. An unchanged dependency bundle can contain
third-party code even if that package is absent from the application's lockfile.

Each package archive below was downloaded from the official npm registry and its
bytes checked against the registry's integrity value. Original license texts
were copied byte-for-byte from the stated archive members. FastDom publishes its
full license as the `README.md` License section; that section is retained without
alteration. The table's hashes describe the retained license files, not the code.
No package installation or lifecycle script was run for this verification.

## Exact package sources and retained license hashes

### @braintree/sanitize-url 7.1.2

- Archive: [https://registry.npmjs.org/@braintree/sanitize-url/-/sanitize-url-7.1.2.tgz](https://registry.npmjs.org/@braintree/sanitize-url/-/sanitize-url-7.1.2.tgz)
- Registry integrity: `sha512-jigsZK+sMF/cuiB7sERuo9V7N9jx+dhmHHnQyDSVdpZwVutaBu7WvNYqMDLSgFgfB30n452TP3vjDAvFC973mA==`
- Archive SHA-256: `fd9a220c24c5cdd406433cce1c3db7f09222d8f7977f0fe087aec914e1a63dc0`
- [mermaid-dependencies/braintree--sanitize-url-7.1.2/LICENSE.txt](mermaid-dependencies/braintree--sanitize-url-7.1.2/LICENSE.txt): SHA-256 `0984740e0c3d725c8044dec7edcefe1dbce180ef5a7bc710c251e19607000158`; source `package/LICENSE`.

### @chevrotain/gast 11.1.2

- Archive: [https://registry.npmjs.org/@chevrotain/gast/-/gast-11.1.2.tgz](https://registry.npmjs.org/@chevrotain/gast/-/gast-11.1.2.tgz)
- Registry integrity: `sha512-Z9zfXR5jNZb1Hlsd/p+4XWeUFugrHirq36bKzPWDSIacV+GPSVXdk+ahVWZTwjhNwofAWg/sZg58fyucKSQx5g==`
- Archive SHA-256: `10d6ea7e6884108dd7167c0aed54c300b525683574e9336ff1507a472414df1e`
- [mermaid-dependencies/chevrotain--gast-11.1.2/LICENSE.txt](mermaid-dependencies/chevrotain--gast-11.1.2/LICENSE.txt): SHA-256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`; source `package/LICENSE.txt`.

### @chevrotain/regexp-to-ast 11.1.2

- Archive: [https://registry.npmjs.org/@chevrotain/regexp-to-ast/-/regexp-to-ast-11.1.2.tgz](https://registry.npmjs.org/@chevrotain/regexp-to-ast/-/regexp-to-ast-11.1.2.tgz)
- Registry integrity: `sha512-nMU3Uj8naWer7xpZTYJdxbAs6RIv/dxYzkYU8GSwgUtcAAlzjcPfX1w+RKRcYG8POlzMeayOQ/znfwxEGo5ulw==`
- Archive SHA-256: `bda3be7ab6ad851d5bc723af365c547e630ddb3f065c2b0513c1a9ac69757294`
- [mermaid-dependencies/chevrotain--regexp-to-ast-11.1.2/LICENSE.txt](mermaid-dependencies/chevrotain--regexp-to-ast-11.1.2/LICENSE.txt): SHA-256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`; source `package/LICENSE.txt`.

### @chevrotain/utils 11.1.2

- Archive: [https://registry.npmjs.org/@chevrotain/utils/-/utils-11.1.2.tgz](https://registry.npmjs.org/@chevrotain/utils/-/utils-11.1.2.tgz)
- Registry integrity: `sha512-4mudFAQ6H+MqBTfqLmU7G1ZwRzCLfJEooL/fsF6rCX5eePMbGhoy5n4g+G4vlh2muDcsCTJtL+uKbOzWxs5LHA==`
- Archive SHA-256: `be2de827ae6eaa5cbd1fa1e912302139992da39e483970cf20556de5cba0194a`
- [mermaid-dependencies/chevrotain--utils-11.1.2/LICENSE.txt](mermaid-dependencies/chevrotain--utils-11.1.2/LICENSE.txt): SHA-256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`; source `package/LICENSE.txt`.

### @iconify/utils 3.0.2

- Archive: [https://registry.npmjs.org/@iconify/utils/-/utils-3.0.2.tgz](https://registry.npmjs.org/@iconify/utils/-/utils-3.0.2.tgz)
- Registry integrity: `sha512-EfJS0rLfVuRuJRn4psJHtK2A9TqVnkxPpHY6lYHiB9+8eSuudsxbwMiavocG45ujOo6FJ+CIRlRnlOGinzkaGQ==`
- Archive SHA-256: `7f1b0f8bd152444d962bbcb258f57583bea55bb05e437eedf4cc950b9b56f969`
- [mermaid-dependencies/iconify--utils-3.0.2/license.txt](mermaid-dependencies/iconify--utils-3.0.2/license.txt): SHA-256 `a86793ac023162ce98b91899601c15f6712f44943163c4f92a0a4bf89152b3bf`; source `package/license.txt`.

### @mermaid-js/parser 1.2.1

- Archive: [https://registry.npmjs.org/@mermaid-js/parser/-/parser-1.2.1.tgz](https://registry.npmjs.org/@mermaid-js/parser/-/parser-1.2.1.tgz)
- Registry integrity: `sha512-n12NohV3mrUyUL2o93IgG/ifeW9FTyeJn3zDxkhwa8MJ9Fxg3HQMlA3RiGmD/3UnJvheztkjjQAjA2T4LmUcpw==`
- Archive SHA-256: `97eef1a4c37110e4836b6eb8dd6a348d989efb370a7672831df01042a7c323f4`
- [mermaid-dependencies/mermaid-js--parser-1.2.1/LICENSE.txt](mermaid-dependencies/mermaid-js--parser-1.2.1/LICENSE.txt): SHA-256 `d374061c40bfb6f99c5033290caefda97a9b3e7e477e5ee02f487143ef2177e8`; source `package/LICENSE`.

### @upsetjs/venn.js 2.0.0

- Archive: [https://registry.npmjs.org/@upsetjs/venn.js/-/venn.js-2.0.0.tgz](https://registry.npmjs.org/@upsetjs/venn.js/-/venn.js-2.0.0.tgz)
- Registry integrity: `sha512-WbBhLrooyePuQ1VZxrJjtLvTc4NVfpOyKx0sKqioq9bX1C1m7Jgykkn8gLrtwumBioXIqam8DLxp88Adbue6Hw==`
- Archive SHA-256: `23c5da5de5c23351c6c6ed891d6416284c05c618e2774bd55484a4c4bef321e4`
- [mermaid-dependencies/upsetjs--venn.js-2.0.0/LICENSE.txt](mermaid-dependencies/upsetjs--venn.js-2.0.0/LICENSE.txt): SHA-256 `6a3508febf2cfccfee96597394543a6154a4bb0b1f91f28404be42c09e9fcb54`; source `package/LICENSE`.

### chevrotain 11.1.2

- Archive: [https://registry.npmjs.org/chevrotain/-/chevrotain-11.1.2.tgz](https://registry.npmjs.org/chevrotain/-/chevrotain-11.1.2.tgz)
- Registry integrity: `sha512-opLQzEVriiH1uUQ4Kctsd49bRoFDXGGSC4GUqj7pGyxM3RehRhvTlZJc1FL/Flew2p5uwxa1tUDWKzI4wNM8pg==`
- Archive SHA-256: `bf2d28019e3a6b2d5f0980440c8467721e6e0a12cdce8b778a32034f3c516297`
- [mermaid-dependencies/chevrotain-11.1.2/LICENSE.txt](mermaid-dependencies/chevrotain-11.1.2/LICENSE.txt): SHA-256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`; source `package/LICENSE.txt`.

### chevrotain-allstar 0.3.1

- Archive: [https://registry.npmjs.org/chevrotain-allstar/-/chevrotain-allstar-0.3.1.tgz](https://registry.npmjs.org/chevrotain-allstar/-/chevrotain-allstar-0.3.1.tgz)
- Registry integrity: `sha512-b7g+y9A0v4mxCW1qUhf3BSVPg+/NvGErk/dOkrDaHA0nQIQGAtrOjlX//9OQtRlSCy+x9rfB5N8yC71lH1nvMw==`
- Archive SHA-256: `51027c5355c69e6404bb6415e2cd27594569616f97daf613535b662cc5cf0763`
- [mermaid-dependencies/chevrotain-allstar-0.3.1/LICENSE.txt](mermaid-dependencies/chevrotain-allstar-0.3.1/LICENSE.txt): SHA-256 `1db2cfbc7ce5fa3b82699b4ac4badce8984084d25b5308ece00f5c9b1381a0a5`; source `package/LICENSE`.

### cose-base 1.0.3

- Archive: [https://registry.npmjs.org/cose-base/-/cose-base-1.0.3.tgz](https://registry.npmjs.org/cose-base/-/cose-base-1.0.3.tgz)
- Registry integrity: `sha512-s9whTXInMSgAp/NVXVNuVxVKzGH2qck3aQlVHxDCdAEPgtMKwc4Wq6/QKhgdEdgbLSi9rBTAcPoRa6JpiG4ksg==`
- Archive SHA-256: `a20640fb8c1a2cf226eb9195785e9f714ba1cce1e80cb8f48d131d1bc0909d18`
- [mermaid-dependencies/cose-base-1.0.3/LICENSE.txt](mermaid-dependencies/cose-base-1.0.3/LICENSE.txt): SHA-256 `5fb3cf4a14c3c5af6e473a192df8bca10c77754e3a0c6492c79fb92a76a5478a`; source `package/LICENSE`.

### cose-base 2.2.0

- Archive: [https://registry.npmjs.org/cose-base/-/cose-base-2.2.0.tgz](https://registry.npmjs.org/cose-base/-/cose-base-2.2.0.tgz)
- Registry integrity: `sha512-AzlgcsCbUMymkADOJtQm3wO9S3ltPfYOFD5033keQn9NJzIbtnZj+UdBJe7DYml/8TdbtHJW3j58SOnKhWY/5g==`
- Archive SHA-256: `612ec91a30b7f2dc158cca4846eeea1b7f89a97fc672951da3c1932107de6da8`
- [mermaid-dependencies/cose-base-2.2.0/LICENSE.txt](mermaid-dependencies/cose-base-2.2.0/LICENSE.txt): SHA-256 `5fb3cf4a14c3c5af6e473a192df8bca10c77754e3a0c6492c79fb92a76a5478a`; source `package/LICENSE`.

### cytoscape 3.34.0

- Archive: [https://registry.npmjs.org/cytoscape/-/cytoscape-3.34.0.tgz](https://registry.npmjs.org/cytoscape/-/cytoscape-3.34.0.tgz)
- Registry integrity: `sha512-62rNSrioXw93uliKFBwjukeQyeWwH2PqDrTac31r2P6464u3AUvTk0xS4LVvT251g7IgkFunrI48ZEZGjywSOg==`
- Archive SHA-256: `4155f863f4408d18bb637afb5808dff7840ca7361437067faf45bbe8c970e768`
- [mermaid-dependencies/cytoscape-3.34.0/LICENSE.txt](mermaid-dependencies/cytoscape-3.34.0/LICENSE.txt): SHA-256 `eb319c6e6f233607f71e8e2f450391751883cfc0eeb3ca7ef574c13d1d9c2203`; source `package/LICENSE`.

### cytoscape-cose-bilkent 4.1.0

- Archive: [https://registry.npmjs.org/cytoscape-cose-bilkent/-/cytoscape-cose-bilkent-4.1.0.tgz](https://registry.npmjs.org/cytoscape-cose-bilkent/-/cytoscape-cose-bilkent-4.1.0.tgz)
- Registry integrity: `sha512-wgQlVIUJF13Quxiv5e1gstZ08rnZj2XaLHGoFMYXz7SkNfCDOOteKBE6SYRfA9WxxI/iBc3ajfDoc6hb/MRAHQ==`
- Archive SHA-256: `9df46b10952452b1d2a5d4cd942f70709a037bc6b7ef25cf1d9fb70be73bb950`
- [mermaid-dependencies/cytoscape-cose-bilkent-4.1.0/LICENSE.txt](mermaid-dependencies/cytoscape-cose-bilkent-4.1.0/LICENSE.txt): SHA-256 `440fc58a56a12814e417d2b341da89b050da052dc75bdb235607d37ec5fe74ef`; source `package/LICENSE`.

### cytoscape-fcose 2.2.0

- Archive: [https://registry.npmjs.org/cytoscape-fcose/-/cytoscape-fcose-2.2.0.tgz](https://registry.npmjs.org/cytoscape-fcose/-/cytoscape-fcose-2.2.0.tgz)
- Registry integrity: `sha512-ki1/VuRIHFCzxWNrsshHYPs6L7TvLu3DL+TyIGEsRcvVERmxokbf5Gdk7mFxZnTdiGtnA4cfSmjZJMviqSuZrQ==`
- Archive SHA-256: `4e1f30e1821fdd4b66f21043c8ea40a8e2ad0ba75e4ccdd2c24d289cf5595432`
- [mermaid-dependencies/cytoscape-fcose-2.2.0/LICENSE.txt](mermaid-dependencies/cytoscape-fcose-2.2.0/LICENSE.txt): SHA-256 `2837634f403949215760fcdd2fa1ed0c64875d02099ecc8318c704b852f1421d`; source `package/LICENSE`.

### d3 7.9.0

- Archive: [https://registry.npmjs.org/d3/-/d3-7.9.0.tgz](https://registry.npmjs.org/d3/-/d3-7.9.0.tgz)
- Registry integrity: `sha512-e1U46jVP+w7Iut8Jt8ri1YsPOvFpg46k+K8TpCb0P+zjCkjkPnV7WzfDJzMHy1LnA+wj5pLT1wjO901gLXeEhA==`
- Archive SHA-256: `7e36605710a2ba54846797c8c6d888911341b215ae53257dc32a49a0b824355e`
- [mermaid-dependencies/d3-7.9.0/LICENSE.txt](mermaid-dependencies/d3-7.9.0/LICENSE.txt): SHA-256 `3e6849627f74ff73c257a3ae1efb574015d94fc1035c05ec3c15805165efcbc4`; source `package/LICENSE`.

### d3-array 2.12.1

- Archive: [https://registry.npmjs.org/d3-array/-/d3-array-2.12.1.tgz](https://registry.npmjs.org/d3-array/-/d3-array-2.12.1.tgz)
- Registry integrity: `sha512-B0ErZK/66mHtEsR1TkPEEkwdy+WDesimkM5gpZr5Dsg54BiTA5RXtYW5qTLIAcekaS9xfZrzBLF/OAkB3Qn1YQ==`
- Archive SHA-256: `3795da9bd345fc440b82be032400c538298e021b559ca48342fe9647e44bb86b`
- [mermaid-dependencies/d3-array-2.12.1/LICENSE.txt](mermaid-dependencies/d3-array-2.12.1/LICENSE.txt): SHA-256 `0747bebeb06b10954913149be9b9a8bdf6fad3e6fdcbd9f9524e7a94c13d2cea`; source `package/LICENSE`.

### d3-array 3.2.4

- Archive: [https://registry.npmjs.org/d3-array/-/d3-array-3.2.4.tgz](https://registry.npmjs.org/d3-array/-/d3-array-3.2.4.tgz)
- Registry integrity: `sha512-tdQAmyA18i4J7wprpYq8ClcxZy3SC31QMeByyCFyRt7BVHdREQZ5lpzoe5mFEYZUWe+oq8HBvk9JjpibyEV4Jg==`
- Archive SHA-256: `6dbf3f2be39e48f86775be6e166a5d3e5a585ca7144453cd6ad1912f5ae4417f`
- [mermaid-dependencies/d3-array-3.2.4/LICENSE.txt](mermaid-dependencies/d3-array-3.2.4/LICENSE.txt): SHA-256 `3e6849627f74ff73c257a3ae1efb574015d94fc1035c05ec3c15805165efcbc4`; source `package/LICENSE`.

### d3-axis 3.0.0

- Archive: [https://registry.npmjs.org/d3-axis/-/d3-axis-3.0.0.tgz](https://registry.npmjs.org/d3-axis/-/d3-axis-3.0.0.tgz)
- Registry integrity: `sha512-IH5tgjV4jE/GhHkRV0HiVYPDtvfjHQlQfJHs0usq7M30XcSBvOotpmH1IgkcXsO/5gEQZD43B//fc7SRT5S+xw==`
- Archive SHA-256: `b5ca6e00b9a2503d6b473485684670564a370733cdc8565a45b63f9fb4d944f6`
- [mermaid-dependencies/d3-axis-3.0.0/LICENSE.txt](mermaid-dependencies/d3-axis-3.0.0/LICENSE.txt): SHA-256 `e008c5e25a6be382593089c29bfabbc553c6378eee02895aec46ce396cc404ee`; source `package/LICENSE`.

### d3-brush 3.0.0

- Archive: [https://registry.npmjs.org/d3-brush/-/d3-brush-3.0.0.tgz](https://registry.npmjs.org/d3-brush/-/d3-brush-3.0.0.tgz)
- Registry integrity: `sha512-ALnjWlVYkXsVIGlOsuWH1+3udkYFI48Ljihfnh8FZPF2QS9o+PzGLBslO0PjzVoHLZ2KCVgAM8NVkXPJB2aNnQ==`
- Archive SHA-256: `fde88a49b16f92d067401df00abf88bf07eec3e091343eb902caf9cab02bdf2a`
- [mermaid-dependencies/d3-brush-3.0.0/LICENSE.txt](mermaid-dependencies/d3-brush-3.0.0/LICENSE.txt): SHA-256 `e008c5e25a6be382593089c29bfabbc553c6378eee02895aec46ce396cc404ee`; source `package/LICENSE`.

### d3-chord 3.0.1

- Archive: [https://registry.npmjs.org/d3-chord/-/d3-chord-3.0.1.tgz](https://registry.npmjs.org/d3-chord/-/d3-chord-3.0.1.tgz)
- Registry integrity: `sha512-VE5S6TNa+j8msksl7HwjxMHDM2yNK3XCkusIlpX5kwauBfXuyLAtNg9jCp/iHH61tgI4sb6R/EIMWCqEIdjT/g==`
- Archive SHA-256: `84c47d193e5e8c5fd3a28783a55b34f08dfaa1c8d764e96d9b49c78a3b6b40b5`
- [mermaid-dependencies/d3-chord-3.0.1/LICENSE.txt](mermaid-dependencies/d3-chord-3.0.1/LICENSE.txt): SHA-256 `e008c5e25a6be382593089c29bfabbc553c6378eee02895aec46ce396cc404ee`; source `package/LICENSE`.

### d3-color 3.1.0

- Archive: [https://registry.npmjs.org/d3-color/-/d3-color-3.1.0.tgz](https://registry.npmjs.org/d3-color/-/d3-color-3.1.0.tgz)
- Registry integrity: `sha512-zg/chbXyeBtMQ1LbD/WSoW2DpC3I0mpmPdW+ynRTj/x2DAWYrIY7qeZIHidozwV24m4iavr15lNwIwLxRmOxhA==`
- Archive SHA-256: `d41bbcd99dd4f00e696546bffc73fed9b8fb6c3354905b6ea1721bff25f33b42`
- [mermaid-dependencies/d3-color-3.1.0/LICENSE.txt](mermaid-dependencies/d3-color-3.1.0/LICENSE.txt): SHA-256 `faa682e3e430941f958d26180458f5934a62f58dac4d70ccdd15608c15d0f884`; source `package/LICENSE`.

### d3-contour 4.0.2

- Archive: [https://registry.npmjs.org/d3-contour/-/d3-contour-4.0.2.tgz](https://registry.npmjs.org/d3-contour/-/d3-contour-4.0.2.tgz)
- Registry integrity: `sha512-4EzFTRIikzs47RGmdxbeUvLWtGedDUNkTcmzoeyg4sP/dvCexO47AaQL7VKy/gul85TOxw+IBgA8US2xwbToNA==`
- Archive SHA-256: `fa347e237c259a987fc3cfd890e2fcb0f2ec42ed125a2c9363854509e86db8f4`
- [mermaid-dependencies/d3-contour-4.0.2/LICENSE.txt](mermaid-dependencies/d3-contour-4.0.2/LICENSE.txt): SHA-256 `e51cba0e4fa1d8c078e15319868f2b90188f413f9ce9dac1043b62db32901e93`; source `package/LICENSE`.

### d3-delaunay 6.0.4

- Archive: [https://registry.npmjs.org/d3-delaunay/-/d3-delaunay-6.0.4.tgz](https://registry.npmjs.org/d3-delaunay/-/d3-delaunay-6.0.4.tgz)
- Registry integrity: `sha512-mdjtIZ1XLAM8bm/hx3WwjfHt6Sggek7qH043O8KEjDXN40xi3vx/6pYSVTwLjEgiXQTbvaouWKynLBiUZ6SK6A==`
- Archive SHA-256: `935113ffa78d545505c8f1accf95be0e48594737eab34db8f50c9d6319907971`
- [mermaid-dependencies/d3-delaunay-6.0.4/LICENSE.txt](mermaid-dependencies/d3-delaunay-6.0.4/LICENSE.txt): SHA-256 `582c3022bd01942336095f92b58a90b1be624dc547d987555c6c956512dd24c1`; source `package/LICENSE`.

### d3-dispatch 3.0.1

- Archive: [https://registry.npmjs.org/d3-dispatch/-/d3-dispatch-3.0.1.tgz](https://registry.npmjs.org/d3-dispatch/-/d3-dispatch-3.0.1.tgz)
- Registry integrity: `sha512-rzUyPU/S7rwUflMyLc1ETDeBj0NRuHKKAcvukozwhshr6g6c5d8zh4c2gQjY2bZ0dXeGLWc1PF174P2tVvKhfg==`
- Archive SHA-256: `3d1a0b5c003e0e9608ad57f6ca21a0c8368031fcbe5f5317fe4e50b3f797ea23`
- [mermaid-dependencies/d3-dispatch-3.0.1/LICENSE.txt](mermaid-dependencies/d3-dispatch-3.0.1/LICENSE.txt): SHA-256 `e008c5e25a6be382593089c29bfabbc553c6378eee02895aec46ce396cc404ee`; source `package/LICENSE`.

### d3-drag 3.0.0

- Archive: [https://registry.npmjs.org/d3-drag/-/d3-drag-3.0.0.tgz](https://registry.npmjs.org/d3-drag/-/d3-drag-3.0.0.tgz)
- Registry integrity: `sha512-pWbUJLdETVA8lQNJecMxoXfH6x+mO2UQo8rSmZ+QqxcbyA3hfeprFgIT//HW2nlHChWeIIMwS2Fq+gEARkhTkg==`
- Archive SHA-256: `a3ccc9d31d85135f35a4eda3ec0fae6ac22435d4e3fe2d2e0c73b5246460d4db`
- [mermaid-dependencies/d3-drag-3.0.0/LICENSE.txt](mermaid-dependencies/d3-drag-3.0.0/LICENSE.txt): SHA-256 `e008c5e25a6be382593089c29bfabbc553c6378eee02895aec46ce396cc404ee`; source `package/LICENSE`.

### d3-dsv 3.0.1

- Archive: [https://registry.npmjs.org/d3-dsv/-/d3-dsv-3.0.1.tgz](https://registry.npmjs.org/d3-dsv/-/d3-dsv-3.0.1.tgz)
- Registry integrity: `sha512-UG6OvdI5afDIFP9w4G0mNq50dSOsXHJaRE8arAS5o9ApWnIElp8GZw1Dun8vP8OyHOZ/QJUKUJwxiiCCnUwm+Q==`
- Archive SHA-256: `fdafcae0362205e2fc63fe3e87fed54822227d9370ce5150914f863ec36153cb`
- [mermaid-dependencies/d3-dsv-3.0.1/LICENSE.txt](mermaid-dependencies/d3-dsv-3.0.1/LICENSE.txt): SHA-256 `7842a82012622e5a37bfe4f6c1b67cd3bae6350716b5bf87f36cea0bdc1319dc`; source `package/LICENSE`.

### d3-ease 3.0.1

- Archive: [https://registry.npmjs.org/d3-ease/-/d3-ease-3.0.1.tgz](https://registry.npmjs.org/d3-ease/-/d3-ease-3.0.1.tgz)
- Registry integrity: `sha512-wR/XK3D3XcLIZwpbvQwQ5fK+8Ykds1ip7A2Txe0yxncXSdq1L9skcG7blcedkOX+ZcgxGAmLX1FrRGbADwzi0w==`
- Archive SHA-256: `b249afe4aa8b741beeaf2d14f625ccf49270adb645e3f1c755d11476c1fdbe2a`
- [mermaid-dependencies/d3-ease-3.0.1/LICENSE.txt](mermaid-dependencies/d3-ease-3.0.1/LICENSE.txt): SHA-256 `b989d9085148d21ff64a75e14462aefa06b2589a55553b07b1460c70081c7d08`; source `package/LICENSE`.

### d3-fetch 3.0.1

- Archive: [https://registry.npmjs.org/d3-fetch/-/d3-fetch-3.0.1.tgz](https://registry.npmjs.org/d3-fetch/-/d3-fetch-3.0.1.tgz)
- Registry integrity: `sha512-kpkQIM20n3oLVBKGg6oHrUchHM3xODkTzjMoj7aWQFq5QEM+R6E4WkzT5+tojDY7yjez8KgCBRoj4aEr99Fdqw==`
- Archive SHA-256: `8a3d61af2bed2b4899df1a90dfed41c0e10ad79d1bea93a18155f5d4e11a526f`
- [mermaid-dependencies/d3-fetch-3.0.1/LICENSE.txt](mermaid-dependencies/d3-fetch-3.0.1/LICENSE.txt): SHA-256 `ffdc17dc9040006bddeb891c95bfbb492e86d6bc64a4a4233666febab1be35e0`; source `package/LICENSE`.

### d3-force 3.0.0

- Archive: [https://registry.npmjs.org/d3-force/-/d3-force-3.0.0.tgz](https://registry.npmjs.org/d3-force/-/d3-force-3.0.0.tgz)
- Registry integrity: `sha512-zxV/SsA+U4yte8051P4ECydjD/S+qeYtnaIyAs9tgHCqfguma/aAQDjo85A9Z6EKhBirHRJHXIgJUlffT4wdLg==`
- Archive SHA-256: `deacfa7ecb466f88717fe1863347dd65e5a5422d9f8c893d771cb2a7f987fa15`
- [mermaid-dependencies/d3-force-3.0.0/LICENSE.txt](mermaid-dependencies/d3-force-3.0.0/LICENSE.txt): SHA-256 `e008c5e25a6be382593089c29bfabbc553c6378eee02895aec46ce396cc404ee`; source `package/LICENSE`.

### d3-format 3.1.0

- Archive: [https://registry.npmjs.org/d3-format/-/d3-format-3.1.0.tgz](https://registry.npmjs.org/d3-format/-/d3-format-3.1.0.tgz)
- Registry integrity: `sha512-YyUI6AEuY/Wpt8KWLgZHsIU86atmikuoOmCfommt0LYHiQSPjvX2AcFc38PX0CBpr2RCyZhjex+NS/LPOv6YqA==`
- Archive SHA-256: `5439103fc9b6f033e02bf68fbeb13ecd2c33442f77ea772a4b2b1bc4f4cee5ba`
- [mermaid-dependencies/d3-format-3.1.0/LICENSE.txt](mermaid-dependencies/d3-format-3.1.0/LICENSE.txt): SHA-256 `e008c5e25a6be382593089c29bfabbc553c6378eee02895aec46ce396cc404ee`; source `package/LICENSE`.

### d3-geo 3.1.1

- Archive: [https://registry.npmjs.org/d3-geo/-/d3-geo-3.1.1.tgz](https://registry.npmjs.org/d3-geo/-/d3-geo-3.1.1.tgz)
- Registry integrity: `sha512-637ln3gXKXOwhalDzinUgY83KzNWZRKbYubaG+fGVuc/dxO64RRljtCTnf5ecMyE1RIdtqpkVcq0IbtU2S8j2Q==`
- Archive SHA-256: `fe1f2dd81a87d942790c5a7786f4aab03df2b357d46d8af56b613fb8a1bb9be5`
- [mermaid-dependencies/d3-geo-3.1.1/LICENSE.txt](mermaid-dependencies/d3-geo-3.1.1/LICENSE.txt): SHA-256 `3e3edc1224eec9c39cd26491a21304a62883c1e5b6a65c5283ccc7a6cc94baee`; source `package/LICENSE`.

### d3-hierarchy 3.1.2

- Archive: [https://registry.npmjs.org/d3-hierarchy/-/d3-hierarchy-3.1.2.tgz](https://registry.npmjs.org/d3-hierarchy/-/d3-hierarchy-3.1.2.tgz)
- Registry integrity: `sha512-FX/9frcub54beBdugHjDCdikxThEqjnR93Qt7PvQTOHxyiNCAlvMrHhclk3cD5VeAaq9fxmfRp+CnWw9rEMBuA==`
- Archive SHA-256: `7681875f06440c088afda1fd834d853dd560166c945e731382ee0c636332360b`
- [mermaid-dependencies/d3-hierarchy-3.1.2/LICENSE.txt](mermaid-dependencies/d3-hierarchy-3.1.2/LICENSE.txt): SHA-256 `e008c5e25a6be382593089c29bfabbc553c6378eee02895aec46ce396cc404ee`; source `package/LICENSE`.

### d3-interpolate 3.0.1

- Archive: [https://registry.npmjs.org/d3-interpolate/-/d3-interpolate-3.0.1.tgz](https://registry.npmjs.org/d3-interpolate/-/d3-interpolate-3.0.1.tgz)
- Registry integrity: `sha512-3bYs1rOD33uo8aqJfKP3JWPAibgw8Zm2+L9vBKEHJ2Rg+viTR7o5Mmv5mZcieN+FRYaAOWX5SJATX6k1PWz72g==`
- Archive SHA-256: `7e8df78d233cd102a0bb518658dc0b7d5c38442b6f2dbc8b95ffc14ba87c7c33`
- [mermaid-dependencies/d3-interpolate-3.0.1/LICENSE.txt](mermaid-dependencies/d3-interpolate-3.0.1/LICENSE.txt): SHA-256 `e008c5e25a6be382593089c29bfabbc553c6378eee02895aec46ce396cc404ee`; source `package/LICENSE`.

### d3-path 1.0.9

- Archive: [https://registry.npmjs.org/d3-path/-/d3-path-1.0.9.tgz](https://registry.npmjs.org/d3-path/-/d3-path-1.0.9.tgz)
- Registry integrity: `sha512-VLaYcn81dtHVTjEHd8B+pbe9yHWpXKZUC87PzoFmsFrJqgFwDe/qxfp5MlfsfM1V5E/iVt0MmEbWQ7FVIXh/bg==`
- Archive SHA-256: `2c10702bad9be578f0827d00e45010ae59cb67165f65462e5c781913a5505db1`
- [mermaid-dependencies/d3-path-1.0.9/LICENSE.txt](mermaid-dependencies/d3-path-1.0.9/LICENSE.txt): SHA-256 `b8265327ab678f554800e71188b1cc6b1ff57522e292d2b1c0be66f27cf328b6`; source `package/LICENSE`.

### d3-path 3.1.0

- Archive: [https://registry.npmjs.org/d3-path/-/d3-path-3.1.0.tgz](https://registry.npmjs.org/d3-path/-/d3-path-3.1.0.tgz)
- Registry integrity: `sha512-p3KP5HCf/bvjBSSKuXid6Zqijx7wIfNW+J/maPs+iwR35at5JCbLUT0LzF1cnjbCHWhqzQTIN2Jpe8pRebIEFQ==`
- Archive SHA-256: `94e9b69f82f113ed4ada36703c05f6b7406723c55affe2a443d69729d6d5da14`
- [mermaid-dependencies/d3-path-3.1.0/LICENSE.txt](mermaid-dependencies/d3-path-3.1.0/LICENSE.txt): SHA-256 `a09b0d6d76e768fca2085fad05743ee81ddd11946bcda160a3cf5e1081a479aa`; source `package/LICENSE`.

### d3-polygon 3.0.1

- Archive: [https://registry.npmjs.org/d3-polygon/-/d3-polygon-3.0.1.tgz](https://registry.npmjs.org/d3-polygon/-/d3-polygon-3.0.1.tgz)
- Registry integrity: `sha512-3vbA7vXYwfe1SYhED++fPUQlWSYTTGmFmQiany/gdbiWgU/iEyQzyymwL9SkJjFFuCS4902BSzewVGsHHmHtXg==`
- Archive SHA-256: `6a33e6b083bd596a08e6f9e973fdb0d098f9ac8348cdc86346bb3e9c15614aca`
- [mermaid-dependencies/d3-polygon-3.0.1/LICENSE.txt](mermaid-dependencies/d3-polygon-3.0.1/LICENSE.txt): SHA-256 `e008c5e25a6be382593089c29bfabbc553c6378eee02895aec46ce396cc404ee`; source `package/LICENSE`.

### d3-quadtree 3.0.1

- Archive: [https://registry.npmjs.org/d3-quadtree/-/d3-quadtree-3.0.1.tgz](https://registry.npmjs.org/d3-quadtree/-/d3-quadtree-3.0.1.tgz)
- Registry integrity: `sha512-04xDrxQTDTCFwP5H6hRhsRcb9xxv2RzkcsygFzmkSIOJy3PeRJP7sNk3VRIbKXcog561P9oU0/rVH6vDROAgUw==`
- Archive SHA-256: `d4145e9cecca8a6077e1099de96375ec9923b0de0df4004bd98aafa17c2d557f`
- [mermaid-dependencies/d3-quadtree-3.0.1/LICENSE.txt](mermaid-dependencies/d3-quadtree-3.0.1/LICENSE.txt): SHA-256 `e008c5e25a6be382593089c29bfabbc553c6378eee02895aec46ce396cc404ee`; source `package/LICENSE`.

### d3-random 3.0.1

- Archive: [https://registry.npmjs.org/d3-random/-/d3-random-3.0.1.tgz](https://registry.npmjs.org/d3-random/-/d3-random-3.0.1.tgz)
- Registry integrity: `sha512-FXMe9GfxTxqd5D6jFsQ+DJ8BJS4E/fT5mqqdjovykEB2oFbTMDVdg1MGFxfQW+FBOGoB++k8swBrgwSHT1cUXQ==`
- Archive SHA-256: `c35794d70beff4e2e2da799cd7fb0e3e763574f24c0fad38c1841770c12b99e8`
- [mermaid-dependencies/d3-random-3.0.1/LICENSE.txt](mermaid-dependencies/d3-random-3.0.1/LICENSE.txt): SHA-256 `e008c5e25a6be382593089c29bfabbc553c6378eee02895aec46ce396cc404ee`; source `package/LICENSE`.

### d3-sankey 0.12.3

- Archive: [https://registry.npmjs.org/d3-sankey/-/d3-sankey-0.12.3.tgz](https://registry.npmjs.org/d3-sankey/-/d3-sankey-0.12.3.tgz)
- Registry integrity: `sha512-nQhsBRmM19Ax5xEIPLMY9ZmJ/cDvd1BG3UVvt5h3WRxKg5zGRbvnteTyWAbzeSvlh3tW7ZEmq4VwR5mB3tutmQ==`
- Archive SHA-256: `6bd8cdb143d4088ff38179def70954419868d4b95f136c168ffef2dad004ff22`
- [mermaid-dependencies/d3-sankey-0.12.3/LICENSE.txt](mermaid-dependencies/d3-sankey-0.12.3/LICENSE.txt): SHA-256 `2bf785e778d67a4f5266cffcd4f2cc5bb98cde73791666e7efeb8002ba32dfa5`; source `package/LICENSE`.

### d3-scale 4.0.2

- Archive: [https://registry.npmjs.org/d3-scale/-/d3-scale-4.0.2.tgz](https://registry.npmjs.org/d3-scale/-/d3-scale-4.0.2.tgz)
- Registry integrity: `sha512-GZW464g1SH7ag3Y7hXjf8RoUuAFIqklOAq3MRl4OaWabTFJY9PN/E1YklhXLh+OQ3fM9yS2nOkCoS+WLZ6kvxQ==`
- Archive SHA-256: `bf50a1f34ba0e6fa25cb7ae902abe0b9e2f85ced39fdca7b18fbe863fbaa39a7`
- [mermaid-dependencies/d3-scale-4.0.2/LICENSE.txt](mermaid-dependencies/d3-scale-4.0.2/LICENSE.txt): SHA-256 `e008c5e25a6be382593089c29bfabbc553c6378eee02895aec46ce396cc404ee`; source `package/LICENSE`.

### d3-scale-chromatic 3.1.0

- Archive: [https://registry.npmjs.org/d3-scale-chromatic/-/d3-scale-chromatic-3.1.0.tgz](https://registry.npmjs.org/d3-scale-chromatic/-/d3-scale-chromatic-3.1.0.tgz)
- Registry integrity: `sha512-A3s5PWiZ9YCXFye1o246KoscMWqf8BsD9eRiJ3He7C9OBaxKhAd5TFCdEx/7VbKtxxTsu//1mMJFrEt572cEyQ==`
- Archive SHA-256: `2573f980e0acbbecc919f5c5fdf7cd3a8110eda2497da7b94ae303fab9c32aa4`
- [mermaid-dependencies/d3-scale-chromatic-3.1.0/LICENSE.txt](mermaid-dependencies/d3-scale-chromatic-3.1.0/LICENSE.txt): SHA-256 `0986d93944902cca9af86824b6a641b4b7c2d10602fc510c433a8bcd443919fe`; source `package/LICENSE`.

### d3-selection 3.0.0

- Archive: [https://registry.npmjs.org/d3-selection/-/d3-selection-3.0.0.tgz](https://registry.npmjs.org/d3-selection/-/d3-selection-3.0.0.tgz)
- Registry integrity: `sha512-fmTRWbNMmsmWq6xJV8D19U/gw/bwrHfNXxrIN+HfZgnzqTHp9jOmKMhsTUjXOJnZOdZY9Q28y4yebKzqDKlxlQ==`
- Archive SHA-256: `a1f872f30dca23b76de89cae9e882f56c325433e7f3aee87b95fa830d12789f3`
- [mermaid-dependencies/d3-selection-3.0.0/LICENSE.txt](mermaid-dependencies/d3-selection-3.0.0/LICENSE.txt): SHA-256 `e008c5e25a6be382593089c29bfabbc553c6378eee02895aec46ce396cc404ee`; source `package/LICENSE`.

### d3-shape 1.3.7

- Archive: [https://registry.npmjs.org/d3-shape/-/d3-shape-1.3.7.tgz](https://registry.npmjs.org/d3-shape/-/d3-shape-1.3.7.tgz)
- Registry integrity: `sha512-EUkvKjqPFUAZyOlhY5gzCxCeI0Aep04LwIRpsZ/mLFelJiUfnK56jo5JMDSE7yyP2kLSb6LtF+S5chMk7uqPqw==`
- Archive SHA-256: `d19261dad8ff192357db2720d57c1786dbfb8c9f42eafe577cb7c4d5b473fd0e`
- [mermaid-dependencies/d3-shape-1.3.7/LICENSE.txt](mermaid-dependencies/d3-shape-1.3.7/LICENSE.txt): SHA-256 `7eea8533ea92bd8c32a901e89ecb0305890905bb12711449565ddff96891146d`; source `package/LICENSE`.

### d3-shape 3.2.0

- Archive: [https://registry.npmjs.org/d3-shape/-/d3-shape-3.2.0.tgz](https://registry.npmjs.org/d3-shape/-/d3-shape-3.2.0.tgz)
- Registry integrity: `sha512-SaLBuwGm3MOViRq2ABk3eLoxwZELpH6zhl3FbAoJ7Vm1gofKx6El1Ib5z23NUEhF9AsGl7y+dzLe5Cw2AArGTA==`
- Archive SHA-256: `8b4b2bc9daa99a957abe17656c5944fd3f28efb88f788e6b4fdba346cb80e602`
- [mermaid-dependencies/d3-shape-3.2.0/LICENSE.txt](mermaid-dependencies/d3-shape-3.2.0/LICENSE.txt): SHA-256 `faa682e3e430941f958d26180458f5934a62f58dac4d70ccdd15608c15d0f884`; source `package/LICENSE`.

### d3-time 3.1.0

- Archive: [https://registry.npmjs.org/d3-time/-/d3-time-3.1.0.tgz](https://registry.npmjs.org/d3-time/-/d3-time-3.1.0.tgz)
- Registry integrity: `sha512-VqKjzBLejbSMT4IgbmVgDjpkYrNWUYJnbCGo874u7MMKIWsILRX+OpX/gTk8MqjpT1A/c6HY2dCA77ZN0lkQ2Q==`
- Archive SHA-256: `a9f2c8e177b76e7068e7c9c77722c4924c71c9e54f9b1e245d27ef11b28dbc08`
- [mermaid-dependencies/d3-time-3.1.0/LICENSE.txt](mermaid-dependencies/d3-time-3.1.0/LICENSE.txt): SHA-256 `faa682e3e430941f958d26180458f5934a62f58dac4d70ccdd15608c15d0f884`; source `package/LICENSE`.

### d3-time-format 4.1.0

- Archive: [https://registry.npmjs.org/d3-time-format/-/d3-time-format-4.1.0.tgz](https://registry.npmjs.org/d3-time-format/-/d3-time-format-4.1.0.tgz)
- Registry integrity: `sha512-dJxPBlzC7NugB2PDLwo9Q8JiTR3M3e4/XANkreKSUxF8vvXKqm1Yfq4Q5dl8budlunRVlUUaDUgFt7eA8D6NLg==`
- Archive SHA-256: `46f1492ef6be8afe04a844876a644a4a964da7f87937e90e93f9585acff9d30e`
- [mermaid-dependencies/d3-time-format-4.1.0/LICENSE.txt](mermaid-dependencies/d3-time-format-4.1.0/LICENSE.txt): SHA-256 `e008c5e25a6be382593089c29bfabbc553c6378eee02895aec46ce396cc404ee`; source `package/LICENSE`.

### d3-timer 3.0.1

- Archive: [https://registry.npmjs.org/d3-timer/-/d3-timer-3.0.1.tgz](https://registry.npmjs.org/d3-timer/-/d3-timer-3.0.1.tgz)
- Registry integrity: `sha512-ndfJ/JxxMd3nw31uyKoY2naivF+r29V+Lc0svZxe1JvvIRmi8hUsrMvdOwgS1o6uBHmiz91geQ0ylPP0aj1VUA==`
- Archive SHA-256: `05cdf901e1876a7f24f4c365a879252752e22e3cc52b131ca616639f07e8ed05`
- [mermaid-dependencies/d3-timer-3.0.1/LICENSE.txt](mermaid-dependencies/d3-timer-3.0.1/LICENSE.txt): SHA-256 `e008c5e25a6be382593089c29bfabbc553c6378eee02895aec46ce396cc404ee`; source `package/LICENSE`.

### d3-transition 3.0.1

- Archive: [https://registry.npmjs.org/d3-transition/-/d3-transition-3.0.1.tgz](https://registry.npmjs.org/d3-transition/-/d3-transition-3.0.1.tgz)
- Registry integrity: `sha512-ApKvfjsSR6tg06xrL434C0WydLr7JewBB3V+/39RMHsaXTOG0zmt/OAXeng5M5LBm0ojmxJrpomQVZ1aPvBL4w==`
- Archive SHA-256: `260eb8eaed565581afc00634ec83c83fd3b7e830e2a6b73b49f3f744dce0254c`
- [mermaid-dependencies/d3-transition-3.0.1/LICENSE.txt](mermaid-dependencies/d3-transition-3.0.1/LICENSE.txt): SHA-256 `e008c5e25a6be382593089c29bfabbc553c6378eee02895aec46ce396cc404ee`; source `package/LICENSE`.

### d3-zoom 3.0.0

- Archive: [https://registry.npmjs.org/d3-zoom/-/d3-zoom-3.0.0.tgz](https://registry.npmjs.org/d3-zoom/-/d3-zoom-3.0.0.tgz)
- Registry integrity: `sha512-b8AmV3kfQaqWAuacbPuNbL6vahnOJflOhexLzMMNLga62+/nh0JzvJ0aO/5a5MVgUFGS7Hu1P9P03o3fJkDCyw==`
- Archive SHA-256: `846d28725c4889d6a2069c6cf084ca7e7730ee917a9b87960ecc53247f840f85`
- [mermaid-dependencies/d3-zoom-3.0.0/LICENSE.txt](mermaid-dependencies/d3-zoom-3.0.0/LICENSE.txt): SHA-256 `e008c5e25a6be382593089c29bfabbc553c6378eee02895aec46ce396cc404ee`; source `package/LICENSE`.

### dagre-d3-es 7.0.14

- Archive: [https://registry.npmjs.org/dagre-d3-es/-/dagre-d3-es-7.0.14.tgz](https://registry.npmjs.org/dagre-d3-es/-/dagre-d3-es-7.0.14.tgz)
- Registry integrity: `sha512-P4rFMVq9ESWqmOgK+dlXvOtLwYg0i7u0HBGJER0LZDJT2VHIPAMZ/riPxqJceWMStH5+E61QxFra9kIS3AqdMg==`
- Archive SHA-256: `488d146fc076978029da937a54628f840dbbcb48e6f95ea79e6c58cc384fe157`
- [mermaid-dependencies/dagre-d3-es-7.0.14/LICENSE.md](mermaid-dependencies/dagre-d3-es-7.0.14/LICENSE.md): SHA-256 `d01eb84ccce437dbf5fd40853bceea0f287930920acea066597a4a25ead63858`; source `package/LICENSE.md`.

### dayjs 1.11.21

- Archive: [https://registry.npmjs.org/dayjs/-/dayjs-1.11.21.tgz](https://registry.npmjs.org/dayjs/-/dayjs-1.11.21.tgz)
- Registry integrity: `sha512-98IT+HOahAisibz/yjKbzuOBwYcjJ7BCLPzARyHiyEBmRz4fatF+KPJszEHXsGYjUG234aH/cOjW1wwTbKUZlA==`
- Archive SHA-256: `290ec8bf81878ae4927581d9be74125f07722ea8bbea2ff77a2226dce12df876`
- [mermaid-dependencies/dayjs-1.11.21/LICENSE.txt](mermaid-dependencies/dayjs-1.11.21/LICENSE.txt): SHA-256 `5faab7526d055651be3aab769d58897be6bd91f3d39d137f25f12dba1b31d5dc`; source `package/LICENSE`.

### dompurify 3.4.12

- Archive: [https://registry.npmjs.org/dompurify/-/dompurify-3.4.12.tgz](https://registry.npmjs.org/dompurify/-/dompurify-3.4.12.tgz)
- Registry integrity: `sha512-zQvGet8Z2sWbQhCmfFz/T5QWH2oBmjnqK3qvOjaqaNLrLEF912WamU+ohnTp0TCep/MFVHpdJuCZEdFOdTnEFg==`
- Archive SHA-256: `4fd255d4cd435ffc74d59b7ffa8b4a92f8e4a7fc84faf1d0f9d298cd7d741616`
- [mermaid-dependencies/dompurify-3.4.12/LICENSE.txt](mermaid-dependencies/dompurify-3.4.12/LICENSE.txt): SHA-256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`; source `package/LICENSE`.
- [mermaid-dependencies/dompurify-3.4.12/LICENSE-MPL.txt](mermaid-dependencies/dompurify-3.4.12/LICENSE-MPL.txt): SHA-256 `fab3dd6bdab226f1c08630b1dd917e11fcb4ec5e1e020e2c16f83a0a13863e85`; source `package/LICENSE-MPL`.

### es-toolkit 1.45.1

- Archive: [https://registry.npmjs.org/es-toolkit/-/es-toolkit-1.45.1.tgz](https://registry.npmjs.org/es-toolkit/-/es-toolkit-1.45.1.tgz)
- Registry integrity: `sha512-/jhoOj/Fx+A+IIyDNOvO3TItGmlMKhtX8ISAHKE90c4b/k1tqaqEZ+uUqfpU8DMnW5cgNJv606zS55jGvza0Xw==`
- Archive SHA-256: `0ab10ae18c0853f0c989ee187cecd9d5b2dd561bdf2b3c9f314bbc981aab427f`
- [mermaid-dependencies/es-toolkit-1.45.1/LICENSE.txt](mermaid-dependencies/es-toolkit-1.45.1/LICENSE.txt): SHA-256 `ed68888a2a28f32a05e88f24d4d4ee75075a1bda2b6372a1f2e00fa0576a5524`; source `package/LICENSE`.

### fastdom 1.0.12

- Archive: [https://registry.npmjs.org/fastdom/-/fastdom-1.0.12.tgz](https://registry.npmjs.org/fastdom/-/fastdom-1.0.12.tgz)
- Registry integrity: `sha512-LB+xjSTEbjHE1cWsxu+tN2Xqr1kpi+V9aADI7sVM5ZMaXyYGPHULQMzpJMYqOTULK/73pUkWVzzObFRBkPr+hg==`
- Archive SHA-256: `15e452be64ae3661c3cc9d736524ebb689c23f162765d60741dcc518ec182265`
- [mermaid-dependencies/fastdom-1.0.12/README-LICENSE.txt](mermaid-dependencies/fastdom-1.0.12/README-LICENSE.txt): SHA-256 `df2ae14f12f31864acef768195afe4584b08a257f25925f49884619279f02f37`; source `package/README.md (License section)`.

### fmin 0.0.4

- Archive: [https://registry.npmjs.org/fmin/-/fmin-0.0.4.tgz](https://registry.npmjs.org/fmin/-/fmin-0.0.4.tgz)
- Registry integrity: `sha512-GDebBdizW6g1F5Kxm/y/D0bKjc8zBeIeGEXpgDuGejMyeaafuLkKZRxEzWKqehDRipxQ8h0cLhdDRCsx6T0t4w==`
- Archive SHA-256: `72a4a30b0c4156fba64269d4c29d3006925c1c821890b06c32e762a560f74de4`
- [mermaid-dependencies/fmin-0.0.4/LICENSE.txt](mermaid-dependencies/fmin-0.0.4/LICENSE.txt): SHA-256 `e4503e78185bff178d3ee91835f082d05771da1b3a2d795f17e03a40251bab77`; source `package/LICENSE`.

### hachure-fill 0.5.2

- Archive: [https://registry.npmjs.org/hachure-fill/-/hachure-fill-0.5.2.tgz](https://registry.npmjs.org/hachure-fill/-/hachure-fill-0.5.2.tgz)
- Registry integrity: `sha512-3GKBOn+m2LX9iq+JC1064cSFprJY4jL1jCXTcpnfER5HYE2l/4EfWSGzkPa/ZDBmYI0ZOEj5VHV/eKnPGkHuOg==`
- Archive SHA-256: `d816b83fea8b39161ef35c46f5080a0a7e406dce39ebf26f1ec8a1daea06a837`
- [mermaid-dependencies/hachure-fill-0.5.2/LICENSE.txt](mermaid-dependencies/hachure-fill-0.5.2/LICENSE.txt): SHA-256 `5e807b516a9be9229ed459880bf353a336e2d947867247290680d437017be391`; source `package/LICENSE`.

### internmap 2.0.3

- Archive: [https://registry.npmjs.org/internmap/-/internmap-2.0.3.tgz](https://registry.npmjs.org/internmap/-/internmap-2.0.3.tgz)
- Registry integrity: `sha512-5Hh7Y1wQbvY5ooGgPbDaL5iYLAPzMTUrjMulskHLH6wnv/A+1q5rgEaiuqEjB+oxGXIVZs1FF+R/KPN3ZSQYYg==`
- Archive SHA-256: `39d1936831a4d3f2bd6e088db28a10de4458d823f652c36b2c808bf5b978c48d`
- [mermaid-dependencies/internmap-2.0.3/LICENSE.txt](mermaid-dependencies/internmap-2.0.3/LICENSE.txt): SHA-256 `9ea8903938dab5f12c4572d60725069bec2d1b0dc3bcc210b09bae946a5ebb1f`; source `package/LICENSE`.

### js-yaml 4.3.0

- Archive: [https://registry.npmjs.org/js-yaml/-/js-yaml-4.3.0.tgz](https://registry.npmjs.org/js-yaml/-/js-yaml-4.3.0.tgz)
- Registry integrity: `sha512-1td788aAnnZ5qs7V2QIRl1owjtYpbKt749Y3xauqQgwIIGF/xXWz1wMTEBx5O3LK3lXLVuqXPdPxj2BoFHaW9Q==`
- Archive SHA-256: `8594ee34496dd2e41ec934fd202843dc993be9ab2d7d5d47579146962fbdfae6`
- [mermaid-dependencies/js-yaml-4.3.0/LICENSE.txt](mermaid-dependencies/js-yaml-4.3.0/LICENSE.txt): SHA-256 `a07bc24468b9654ce76a547d47a2db282d07733b715db4c73a98bd63961f9550`; source `package/LICENSE`.

### katex 0.16.47

- Archive: [https://registry.npmjs.org/katex/-/katex-0.16.47.tgz](https://registry.npmjs.org/katex/-/katex-0.16.47.tgz)
- Registry integrity: `sha512-Eeo8Ys1doU1z+x8AZsPpQu+p/QcZBI5PeOo7QGQdy2x2m0MU/hYagBbGOmXwr5KVbEfVuWv9LpnQWeehogurjg==`
- Archive SHA-256: `ad2d1ab2f7fcc227019784320e8a2c5218ff6bb333b36df4136d10365ae29375`
- [mermaid-dependencies/katex-0.16.47/LICENSE.txt](mermaid-dependencies/katex-0.16.47/LICENSE.txt): SHA-256 `766ccc1f306c885aa45542a9846bbd0a505b27a0374f146778171c2254ce18e3`; source `package/LICENSE`.

### khroma 2.1.0

- Archive: [https://registry.npmjs.org/khroma/-/khroma-2.1.0.tgz](https://registry.npmjs.org/khroma/-/khroma-2.1.0.tgz)
- Registry integrity: `sha512-Ls993zuzfayK269Svk9hzpeGUKob/sIgZzyHYdjQoAdQetRKpOLj+k/QQQ/6Qi0Yz65mlROrfd+Ev+1+7dz9Kw==`
- Archive SHA-256: `8963d209f3a682374d7f7e45e5fa361a58fc060c8528df6656fae0fc7c508110`
- [mermaid-dependencies/khroma-2.1.0/license.txt](mermaid-dependencies/khroma-2.1.0/license.txt): SHA-256 `66b333b0f66759a0b710459e03f7029abe17f4358114a128d2c972e642961b49`; source `package/license`.

### langium 4.2.1

- Archive: [https://registry.npmjs.org/langium/-/langium-4.2.1.tgz](https://registry.npmjs.org/langium/-/langium-4.2.1.tgz)
- Registry integrity: `sha512-zu9QWmjpzJcomzdJQAHgDVhLGq5bLosVak1KVa40NzQHXfqr4eAHupvnPOVXEoLkg6Ocefvf/93d//SB7du4YQ==`
- Archive SHA-256: `640d97d6f78fc6c98411863f9390e516cb9d714d80b12a56e5b1b1e7e18e4f20`
- [mermaid-dependencies/langium-4.2.1/LICENSE.txt](mermaid-dependencies/langium-4.2.1/LICENSE.txt): SHA-256 `599bf70b4e55f06250571d103dbd8441e0c47cb7f858c0147ca312ce38e9ef2a`; source `package/LICENSE`.

### layout-base 1.0.2

- Archive: [https://registry.npmjs.org/layout-base/-/layout-base-1.0.2.tgz](https://registry.npmjs.org/layout-base/-/layout-base-1.0.2.tgz)
- Registry integrity: `sha512-8h2oVEZNktL4BH2JCOI90iD1yXwL6iNW7KcCKT2QZgQJR2vbqDsldCTPRU9NifTCqHZci57XvQQ15YTu+sTYPg==`
- Archive SHA-256: `efea1306903d9d043c42c1e7931b2d97b4f519cff04b1347fa308032a52eebab`
- [mermaid-dependencies/layout-base-1.0.2/LICENSE.txt](mermaid-dependencies/layout-base-1.0.2/LICENSE.txt): SHA-256 `eabb762d8a95109a39c9be3247325529a5239a7aca327d909c3ccdc41f3a06bf`; source `package/LICENSE`.

### layout-base 2.0.1

- Archive: [https://registry.npmjs.org/layout-base/-/layout-base-2.0.1.tgz](https://registry.npmjs.org/layout-base/-/layout-base-2.0.1.tgz)
- Registry integrity: `sha512-dp3s92+uNI1hWIpPGH3jK2kxE2lMjdXdr+DH8ynZHpd6PUlH6x6cbuXnoMmiNumznqaNO31xu9e79F0uuZ0JFg==`
- Archive SHA-256: `34165e46d8c4b9d719a592e39a60fa5f7324c21a3edd02733e1116b17013defd`
- [mermaid-dependencies/layout-base-2.0.1/LICENSE.txt](mermaid-dependencies/layout-base-2.0.1/LICENSE.txt): SHA-256 `eabb762d8a95109a39c9be3247325529a5239a7aca327d909c3ccdc41f3a06bf`; source `package/LICENSE`.

### lodash-es 4.17.23

- Archive: [https://registry.npmjs.org/lodash-es/-/lodash-es-4.17.23.tgz](https://registry.npmjs.org/lodash-es/-/lodash-es-4.17.23.tgz)
- Registry integrity: `sha512-kVI48u3PZr38HdYz98UmfPnXl2DXrpdctLrFLCd3kOx1xUkOmpFPx7gCWWM5MPkL/fD8zb+Ph0QzjGFs4+hHWg==`
- Archive SHA-256: `2dbc40d4f256e6c2eccc6c355e5e068acf78b3117a8b0c458be004319a3108ff`
- [mermaid-dependencies/lodash-es-4.17.23/LICENSE.txt](mermaid-dependencies/lodash-es-4.17.23/LICENSE.txt): SHA-256 `f71e8ed126b46346494aad5486874cd8f0aafe95092ed67d2e3cb6110f939abc`; source `package/LICENSE`.

### lodash-es 4.18.1

- Archive: [https://registry.npmjs.org/lodash-es/-/lodash-es-4.18.1.tgz](https://registry.npmjs.org/lodash-es/-/lodash-es-4.18.1.tgz)
- Registry integrity: `sha512-J8xewKD/Gk22OZbhpOVSwcs60zhd95ESDwezOFuA3/099925PdHJ7OFHNTGtajL3AlZkykD32HykiMo+BIBI8A==`
- Archive SHA-256: `b0c810e5cd4cd580ed7b18fc71384b9a80c151dc5c85b1729bd656a49e3f16f8`
- [mermaid-dependencies/lodash-es-4.18.1/LICENSE.txt](mermaid-dependencies/lodash-es-4.18.1/LICENSE.txt): SHA-256 `f71e8ed126b46346494aad5486874cd8f0aafe95092ed67d2e3cb6110f939abc`; source `package/LICENSE`.

### marked 16.3.0

- Archive: [https://registry.npmjs.org/marked/-/marked-16.3.0.tgz](https://registry.npmjs.org/marked/-/marked-16.3.0.tgz)
- Registry integrity: `sha512-K3UxuKu6l6bmA5FUwYho8CfJBlsUWAooKtdGgMcERSpF7gcBUrCGsLH7wDaaNOzwq18JzSUDyoEb/YsrqMac3w==`
- Archive SHA-256: `c333c47cd3802a1d631dfdd8c6cfc411a88599a872c04ce8cd2291381a7767a0`
- [mermaid-dependencies/marked-16.3.0/LICENSE.md](mermaid-dependencies/marked-16.3.0/LICENSE.md): SHA-256 `8e3a3f82f59a60958f56ca08f445647c32a4733dc7ca6c2c46f6eb898471ab9c`; source `package/LICENSE.md`.

### mermaid 11.17.2

- Archive: [https://registry.npmjs.org/mermaid/-/mermaid-11.17.2.tgz](https://registry.npmjs.org/mermaid/-/mermaid-11.17.2.tgz)
- Registry integrity: `sha512-V6K3C8EBdEsPFZXSKMJe6ppQOENxuHARr9GvHX4hh47lAbhMRD9qf4oEK7LoaRQxULMa80/qt5gHO73aCleBBg==`
- Archive SHA-256: `6ad2f42c3fc26bbf9e45cbb6d11898972573ea52b33a5f4ff51952899f950ffd`
- [mermaid-dependencies/mermaid-11.17.2/LICENSE.txt](mermaid-dependencies/mermaid-11.17.2/LICENSE.txt): SHA-256 `ec9fb67dcb25eccc416ed56e1aab819222c805a2a4bfe4cb19e7556bf2ffde80`; source `package/LICENSE`.

### path-data-parser 0.1.0

- Archive: [https://registry.npmjs.org/path-data-parser/-/path-data-parser-0.1.0.tgz](https://registry.npmjs.org/path-data-parser/-/path-data-parser-0.1.0.tgz)
- Registry integrity: `sha512-NOnmBpt5Y2RWbuv0LMzsayp3lVylAHLPUTut412ZA3l+C4uw4ZVkQbjShYCQ8TCpUMdPapr4YjUqLYD6v68j+w==`
- Archive SHA-256: `09be555fc313a8e831b55d4cc727699655f5c224fde2d8062f3f52bc9386d3b0`
- [mermaid-dependencies/path-data-parser-0.1.0/LICENSE.txt](mermaid-dependencies/path-data-parser-0.1.0/LICENSE.txt): SHA-256 `e9754a00aebde654e80f40bcf41dab667d6a41dfbbd2912bcf14fb07d468bf71`; source `package/LICENSE`.

### points-on-curve 0.2.0

- Archive: [https://registry.npmjs.org/points-on-curve/-/points-on-curve-0.2.0.tgz](https://registry.npmjs.org/points-on-curve/-/points-on-curve-0.2.0.tgz)
- Registry integrity: `sha512-0mYKnYYe9ZcqMCWhUjItv/oHjvgEsfKvnUTg8sAtnHr3GVy7rGkXCb6d5cSyqrWqL4k81b9CPg3urd+T7aop3A==`
- Archive SHA-256: `adc00f4d5ae800c315aea316822fb6f8dd4529f76107facbdccf356372e5ddbf`
- [mermaid-dependencies/points-on-curve-0.2.0/LICENSE.txt](mermaid-dependencies/points-on-curve-0.2.0/LICENSE.txt): SHA-256 `e9754a00aebde654e80f40bcf41dab667d6a41dfbbd2912bcf14fb07d468bf71`; source `package/LICENSE`.

### points-on-path 0.2.1

- Archive: [https://registry.npmjs.org/points-on-path/-/points-on-path-0.2.1.tgz](https://registry.npmjs.org/points-on-path/-/points-on-path-0.2.1.tgz)
- Registry integrity: `sha512-25ClnWWuw7JbWZcgqY/gJ4FQWadKxGWk+3kR/7kD0tCaDtPPMj7oHu2ToLaVhfpnHrZzYby2w6tUA0eOIuUg8g==`
- Archive SHA-256: `eb57ddbb156d4e73cbc8d9416e1b666ace0d8abf9dc783f8c934ab63dbae6e44`
- [mermaid-dependencies/points-on-path-0.2.1/LICENSE.txt](mermaid-dependencies/points-on-path-0.2.1/LICENSE.txt): SHA-256 `b6fc1f7f1d96a48bc97176f3dcef959e364c5c17ba44167511de421500a86c6c`; source `package/LICENSE`.

### roughjs 4.6.6

- Archive: [https://registry.npmjs.org/roughjs/-/roughjs-4.6.6.tgz](https://registry.npmjs.org/roughjs/-/roughjs-4.6.6.tgz)
- Registry integrity: `sha512-ZUz/69+SYpFN/g/lUlo2FXcIjRkSu3nDarreVdGGndHEBJ6cXPdKguS8JGxwj5HA5xIbVKSmLgr5b3AWxtRfvQ==`
- Archive SHA-256: `373873b2c3f1b7ddba878525c774816057c5818029780c7fba081f06018ba78c`
- [mermaid-dependencies/roughjs-4.6.6/LICENSE.txt](mermaid-dependencies/roughjs-4.6.6/LICENSE.txt): SHA-256 `dca9a392272606ac748ac0976a2a1133f14eef841c27beaa51a844d53c56a09d`; source `package/LICENSE`.

### stylis 4.3.6

- Archive: [https://registry.npmjs.org/stylis/-/stylis-4.3.6.tgz](https://registry.npmjs.org/stylis/-/stylis-4.3.6.tgz)
- Registry integrity: `sha512-yQ3rwFWRfwNUY7H5vpU0wfdkNSnvnJinhF9830Swlaxl03zsOjCfmX0ugac+3LtK0lYSgwL/KXc8oYL3mG4YFQ==`
- Archive SHA-256: `57bd37727276e7e30d2f15472a43c5d5b8ae6cd9cebd36dbb84880c500de568e`
- [mermaid-dependencies/stylis-4.3.6/LICENSE.txt](mermaid-dependencies/stylis-4.3.6/LICENSE.txt): SHA-256 `88c579c6ee44b41137a21321190d177982e5b17d4fa1b83a4a2e3ea325a8fc9a`; source `package/LICENSE`.

### ts-dedent 2.2.0

- Archive: [https://registry.npmjs.org/ts-dedent/-/ts-dedent-2.2.0.tgz](https://registry.npmjs.org/ts-dedent/-/ts-dedent-2.2.0.tgz)
- Registry integrity: `sha512-q5W7tVM71e2xjHZTlgfTDoPF/SmqKG5hddq9SzR49CH2hayqRKJtQ4mtRlSxKaJlR/+9rEM+mnBHf7I2/BQcpQ==`
- Archive SHA-256: `f04cddc15ce3aad91287aebdcb0d6b6997b85222769c35c910038f59bfd2234d`
- [mermaid-dependencies/ts-dedent-2.2.0/LICENSE.txt](mermaid-dependencies/ts-dedent-2.2.0/LICENSE.txt): SHA-256 `eff13095d9d762c3bd9dda74370c81e2130c28f2691bc455603abf973bac25b9`; source `package/LICENSE`.

### uuid 14.0.0

- Archive: [https://registry.npmjs.org/uuid/-/uuid-14.0.0.tgz](https://registry.npmjs.org/uuid/-/uuid-14.0.0.tgz)
- Registry integrity: `sha512-Qo+uWgilfSmAhXCMav1uYFynlQO7fMFiMVZsQqZRMIXp0O7rR7qjkj+cPvBHLgBqi960QCoo/PH2/6ZtVqKvrg==`
- Archive SHA-256: `ca468c168ec7f2021f6a98041e943443b29e67e0e0ff5b4c1caca17c6efa9870`
- [mermaid-dependencies/uuid-14.0.0/LICENSE.md](mermaid-dependencies/uuid-14.0.0/LICENSE.md): SHA-256 `beaa6b04fb82e41dd2ad679e19e27953afb5999b1abbb455b6564e78ebfeb332`; source `package/LICENSE.md`.

### vscode-jsonrpc 8.2.0

- Archive: [https://registry.npmjs.org/vscode-jsonrpc/-/vscode-jsonrpc-8.2.0.tgz](https://registry.npmjs.org/vscode-jsonrpc/-/vscode-jsonrpc-8.2.0.tgz)
- Registry integrity: `sha512-C+r0eKJUIfiDIfwJhria30+TYWPtuHJXHtI7J0YlOmKAo7ogxP20T0zxB7HZQIFhIyvoBPwWskjxrvAtfjyZfA==`
- Archive SHA-256: `3da44531c398f1545074cb728e359a822f35b9f8ac7171c847f42f0728b9c7cb`
- [mermaid-dependencies/vscode-jsonrpc-8.2.0/License.txt](mermaid-dependencies/vscode-jsonrpc-8.2.0/License.txt): SHA-256 `ec9ee83580841e8eb687aca9867f221503809ba6426c7f876ede17d91b9fcfd0`; source `package/License.txt`.

### vscode-languageserver-protocol 3.17.5

- Archive: [https://registry.npmjs.org/vscode-languageserver-protocol/-/vscode-languageserver-protocol-3.17.5.tgz](https://registry.npmjs.org/vscode-languageserver-protocol/-/vscode-languageserver-protocol-3.17.5.tgz)
- Registry integrity: `sha512-mb1bvRJN8SVznADSGWM9u/b07H7Ecg0I3OgXDuLdn307rl/J3A9YD6/eYOssqhecL27hK1IPZAsaqh00i/Jljg==`
- Archive SHA-256: `7473eb2d2163f3f8bea09644f9d803789a195e596b65d3946c4157e583e3ccc8`
- [mermaid-dependencies/vscode-languageserver-protocol-3.17.5/License.txt](mermaid-dependencies/vscode-languageserver-protocol-3.17.5/License.txt): SHA-256 `ec9ee83580841e8eb687aca9867f221503809ba6426c7f876ede17d91b9fcfd0`; source `package/License.txt`.

### vscode-languageserver-textdocument 1.0.12

- Archive: [https://registry.npmjs.org/vscode-languageserver-textdocument/-/vscode-languageserver-textdocument-1.0.12.tgz](https://registry.npmjs.org/vscode-languageserver-textdocument/-/vscode-languageserver-textdocument-1.0.12.tgz)
- Registry integrity: `sha512-cxWNPesCnQCcMPeenjKKsOCKQZ/L6Tv19DTRIGuLWe32lyzWhihGVJ/rcckZXJxfdKCFvRLS3fpBIsV/ZGX4zA==`
- Archive SHA-256: `9f1d28814d6ee81267f52f5bc8c920bb6a0a23eb6de48960345a0a25fbf3b0db`
- [mermaid-dependencies/vscode-languageserver-textdocument-1.0.12/License.txt](mermaid-dependencies/vscode-languageserver-textdocument-1.0.12/License.txt): SHA-256 `ec9ee83580841e8eb687aca9867f221503809ba6426c7f876ede17d91b9fcfd0`; source `package/License.txt`.

### vscode-languageserver-types 3.17.5

- Archive: [https://registry.npmjs.org/vscode-languageserver-types/-/vscode-languageserver-types-3.17.5.tgz](https://registry.npmjs.org/vscode-languageserver-types/-/vscode-languageserver-types-3.17.5.tgz)
- Registry integrity: `sha512-Ld1VelNuX9pdF39h2Hgaeb5hEZM2Z3jUrrMgWQAu82jMtZp7p3vJT3BzToKtZI7NgQssZje5o0zryOrhQvzQAg==`
- Archive SHA-256: `d673f9e7f8bbe51351be51c58f32d4dcfa97a670ebb86bc633368394c609cac0`
- [mermaid-dependencies/vscode-languageserver-types-3.17.5/License.txt](mermaid-dependencies/vscode-languageserver-types-3.17.5/License.txt): SHA-256 `ec9ee83580841e8eb687aca9867f221503809ba6426c7f876ede17d91b9fcfd0`; source `package/License.txt`.

