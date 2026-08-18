# MCAP Slice for VS Code

MCAP Slice opens indexed `.mcap` recordings directly inside desktop VS Code.
The source recording stays on the workspace host and is always treated as
read-only.

## Features

- Inspect recording bounds, profile, library, topics, channels, schemas, and
  message counts.
- Select a millisecond-precision `[In, Out)` range with RFC 3339 timestamps
  displayed in `Asia/Shanghai`.
- Select topic names for export. All channels with the same selected topic name
  are preserved.
- Preview individual JPEG or PNG frames from ROS 2 CDR
  `sensor_msgs/msg/CompressedImage` channels without loading image payloads into
  the timeline.
- Export indexed slices with Zstandard, LZ4, or no compression.
- Preserve schemas, selected channels and their metadata, and top-level MCAP
  Metadata, then append `mcap_slice.provenance.v1`.

## Usage

1. Install the VSIX and open a file with a `.mcap` extension from the Explorer.
2. Choose the In and Out timestamps and explicitly select at least one topic.
3. Choose a compression mode and select **Export Slice…**.

MCAP Slice writes a uniquely named temporary file beside the destination and
only replaces the destination after the writer closes successfully. It refuses
to use the source recording as the destination. If the source size or modified
time changes, export is disabled until **Reload Source** is selected.

## Workspace support

The extension runs as a workspace extension and supports desktop VS Code with:

- local folders;
- Remote - SSH;
- WSL; and
- Dev Containers.

For remote workspaces, reading and export happen on the remote workspace host.
The extension supports only `file:` resources with random file access. It does
not run in `vscode.dev`, virtual workspaces, or browser extension hosts.

## Current limitations

- The MCAP must contain a usable Summary and Chunk Index. The extension does not
  fall back to a full sequential scan.
- Attachments are reported but are not copied to exported recordings.
- Video is single-stream, frame-by-frame preview only. There is no playback,
  multi-stream synchronization, or depth-image preview.
- Topic selections, frame indexes, and source contents are not persisted after
  the editor tab closes.

No source data, telemetry, fonts, or other requests are sent to external
services. The Webview uses a restrictive Content Security Policy and VS Code
theme variables.

## Development

Requires Node.js 22 and VS Code 1.95 or newer.

```bash
cd vscode-extension
npm ci
npm run typecheck
npm run lint
npm test
npm run test:integration
npm run package
```

The VSIX is written to `../dist/mcap-slice-vscode.vsix`. Integration
tests download an isolated VS Code runtime into the ignored `.vscode-test/`
directory.

Release candidates should also follow the [manual smoke matrix](docs/SMOKE_TEST_MATRIX.md).

## Marketplace releases

Release packaging is driven by version tags. CI does not receive Marketplace
credentials and never publishes automatically.

For each release, update the version in both `package.json` and
`package-lock.json`, update this extension changelog, and merge those changes to
`main`. Then create and push the matching tag:

```bash
extension_version="$(node -p "require('./vscode-extension/package.json').version")"
git tag "vscode-v${extension_version}"
git push origin "vscode-v${extension_version}"
```

The tag must exactly match `vscode-vX.Y.Z`. The package workflow installs from
the lock file, runs typecheck, lint, unit/worker tests, the isolated VS Code
integration test, packages one VSIX, and uploads it as the
`mcap-slice-vscode-X.Y.Z` workflow artifact.

After the workflow succeeds, download and extract that artifact from
**Actions → Package VS Code Extension**. In the Visual Studio Marketplace
publisher portal, choose **New extension → Visual Studio Code** and upload the
contained `mcap-slice-vscode.vsix`. The matching publisher and extension ID
make it a new version of the existing listing. Marketplace versions cannot be
overwritten, so always increment the extension version before creating another
release tag.

## License

MCAP Slice is available under the [MIT License](LICENSE). Third-party notices
are documented in the repository's [Third-party notices](https://github.com/TANG617/MCAP-Slice/blob/main/THIRD_PARTY_NOTICES.md).
