# Third-party Notices

MCAP Slice is distributed under the [MIT License](LICENSE). It includes or
links against the following third-party software. Each component remains under
its own license; the MCAP Slice license does not replace those terms.

## Qt 6

- Project: [Qt](https://www.qt.io/)
- Use: application framework, widgets, image decoding, and platform plugins
- License: GNU LGPL version 3, GNU GPL version 3, or a commercial Qt license,
  depending on the Qt distribution used
- Source and license information:
  [Qt licensing](https://doc.qt.io/qt-6/licensing.html)

Desktop release packages dynamically link and bundle the applicable Qt runtime
libraries and plugins. Qt may include additional third-party components under
their respective licenses. Refer to the Qt distribution's license and Software
Bill of Materials for the exact packaged version.

## MCAP C++ 1.3.0

- Project: [foxglove/mcap](https://github.com/foxglove/mcap)
- Use: MCAP reader, writer, records, indexes, and compression integration
- License: MIT
- Copyright: Foxglove Technologies Inc
- Source in this repository: `3rdparty/mcap-1.3.0`
- Upstream license:
  [MCAP LICENSE](https://github.com/foxglove/mcap/blob/releases/cpp/v1.3.0/LICENSE)

## LZ4 1.9.4

- Project: [lz4/lz4](https://github.com/lz4/lz4)
- Use: MCAP LZ4 compression and decompression
- License: BSD 2-Clause
- Copyright: 2011–2020 Yann Collet
- Source in this repository: `3rdparty/lz4-1.9.4`
- Included license: `3rdparty/lz4-1.9.4/lib/LICENSE`

## Zstandard 1.5.5

- Project: [facebook/zstd](https://github.com/facebook/zstd)
- Use: MCAP Zstandard compression and decompression
- License used by this project: BSD 3-Clause
- Copyright: Meta Platforms, Inc. and affiliates
- Source in this repository: `3rdparty/zstd-1.5.5`
- Upstream license:
  [Zstandard LICENSE](https://github.com/facebook/zstd/blob/v1.5.5/LICENSE)

## Original project

MCAP Slice originated from
[facontidavide/mcap_editor](https://github.com/facontidavide/mcap_editor),
copyright 2023 Davide Faconti, under the MIT License. That copyright is
preserved in the root [LICENSE](LICENSE).

## VS Code extension dependencies

The optional VS Code extension in `vscode-extension/` uses these runtime and
bundled Webview dependencies:

- `@mcap/core` 2.2.1 and `@mcap/nodejs` 1.1.0 — MIT;
- `@foxglove/wasm-lz4` 1.0.2 and `@foxglove/wasm-zstd` 1.0.1 — MIT;
- `lz4js` 0.2.0 — ISC; and
- React and React DOM 19.2.8 — MIT.

Exact transitive versions and integrity hashes are recorded in
`vscode-extension/package-lock.json`. Build and test-only npm packages remain
under their respective licenses.

## Trademarks

Qt and associated marks belong to The Qt Company and their respective owners.
Other project and product names may be trademarks of their respective owners.
Their use here identifies compatibility or dependency relationships and does
not imply endorsement.
