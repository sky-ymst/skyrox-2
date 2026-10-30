# Third-party notices

The Interstellar and Dogeub application UIs are not included. Their
Scramjet-compatible proxy profiles are integrated into Yoroxy's existing UI.

The following runtime packages are distributed under the GNU AGPL version 3:

- `@mercuryworkshop/wisp-js` — AGPL-3.0
- `@mercuryworkshop/libcurl-transport` — AGPL-3.0-only
- `@mercuryworkshop/epoxy-transport` — AGPL-3.0-only

The following AGPL-3.0 projects are upstream references for the respective
proxy profiles and configuration:

- Interstellar — https://github.com/UseInterstellar/Interstellar
- Dogeub — https://github.com/xorynix/dogeub

The Interstellar profile follows its Scramjet URL prefix and codec
(`static/assets/scramjet/scramjet.config.js`), service-worker routing
(`static/sw.js`), and Epoxy/Wisp transport setup
(`static/assets/js/search.js`). The Dogeub profile follows its Scramjet prefix,
Libcurl/Wisp transport, and URL codec (`src/utils/hooks/loader/useReg.js` and
`src/utils/hooks/loader/of.js`), with its Scramjet worker flow from
`public/s_sw.js`.

Other bundled runtime packages:

- `@mercuryworkshop/scramjet` — MIT License
- `@mercuryworkshop/bare-mux` — MIT License

License metadata and/or license texts are included with the packages. The
corresponding source and license information are available from the package
registries and upstream repositories:

- https://github.com/MercuryWorkshop/scramjet
- https://github.com/MercuryWorkshop/wisp-js
- https://github.com/MercuryWorkshop/LibcurlTransport
- https://github.com/MercuryWorkshop/EpoxyTransport
- https://github.com/MercuryWorkshop/bare-mux
