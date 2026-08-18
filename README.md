# MCAP Slice

[English](README.md) · [简体中文](README.zh-CN.md)

MCAP Slice provides a standalone desktop application and a VS Code extension
for visually trimming MCAP recordings and exporting only the topics you need.
Both keep the source file read-only and process recordings on the machine that
owns the workspace.

It is built with Qt 6 and the MCAP C++ library. ROS is not required to install
or run the application.

![MCAP Slice showing a synthetic recording, folder navigation, video preview, topic selection, and export range](screenshot.png)

## Download

Download the package for your platform from
[GitHub Releases](https://github.com/TANG617/MCAP-Slice/releases).

| Platform | Package |
| --- | --- |
| macOS 12 or later, Apple Silicon | macOS DMG for arm64 |
| macOS 12 or later, Intel | macOS DMG for x86_64 |
| Windows, x86_64 | Windows desktop package |
| Ubuntu, x86_64 | AppImage |
| VS Code 1.95 or later | `mcap-slice-vscode.vsix` |

Release assets are version-independent in this documentation. Choose the asset
whose platform and architecture match your system.

## VS Code extension

Install the VSIX from the Extensions view, then open an indexed `.mcap` file
from the Explorer. The extension becomes the default read-only editor and
provides recording details, Topic/Schema inspection, `[In, Out)` range editing,
single-frame ROS 2 CompressedImage preview, and Zstandard/LZ4/uncompressed
export.

The extension supports local desktop VS Code, Remote - SSH, WSL, and Dev
Containers. Remote recordings stay on the remote workspace host. Browser VS
Code, virtual workspaces, and unindexed MCAP files are not supported in v0.1.x.
See the [extension README](vscode-extension/README.md) for usage and development
instructions.

## Quick start

1. Open one MCAP file, drop it on the window, or open a folder containing
   multiple `.mcap` files.
2. Set the **In** and **Out** times and select the topics to export. The video
   preview is independent from the export selection.
3. Choose Zstandard, LZ4, or no compression, then select **Export…**.

MCAP Slice writes to a new file atomically and refuses to overwrite the source
recording.

## Highlights

- Drag video-style In/Out handles or paste exact absolute timestamps.
- Display time consistently as RFC 3339 in `Asia/Shanghai`, for example
  `2026-07-30T04:06:56.682+08:00`.
- Accept timestamps with `Z` or another UTC offset and convert the same instant
  to `+08:00`.
- Preview Qt-decodable ROS 2 CDR
  `sensor_msgs/msg/CompressedImage` streams without loading every image into
  memory.
- Navigate the first level of a folder and switch quickly between its MCAP
  files.
- Keep explicitly selected topic names across files in the current folder
  session.
- Synchronize duplicate channels that share the same topic name.
- Export with Zstandard, LZ4, or no compression.
- Preserve schemas, channels, channel Metadata, and source top-level Metadata.
- Append `mcap_slice.provenance.v1` Metadata so every exported slice can be
  traced to its immediate source.
- Follow the native light or dark appearance of the desktop.

## Time and selection semantics

- Topic selection starts empty for every new single-file or folder session.
- The **Out** timestamp is an exclusive boundary: messages at exactly that time
  are not exported.
- The editor works at millisecond precision. Provenance also stores the source
  recording's original nanosecond bounds without losing precision.
- Selecting a stream for video preview never selects it for export.

See the [User Guide](docs/USER_GUIDE.md) for the complete workflow and common
error cases.

## Supported data and current limitations

MCAP Slice can trim and copy regular MCAP message channels regardless of
whether ROS is installed. Video preview has narrower requirements: the channel
must use ROS 2 CDR encoding, its schema must be
`sensor_msgs/msg/CompressedImage`, and the compressed payload must be
decodable by Qt, such as JPEG.

MCAP attachments are not copied. Keep the source recording until the exported
file has been verified for your workflow.

Folder browsing is non-recursive. The application lists only `.mcap` files
directly inside the selected folder.

## Documentation

- [User Guide](docs/USER_GUIDE.md)
- [Build from source](docs/BUILDING.md)
- [Provenance Metadata](docs/PROVENANCE.md)
- [Development and architecture](docs/DEVELOPMENT.md)
- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)
- [Support](SUPPORT.md)
- [Security policy](SECURITY.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)
- [VS Code extension](vscode-extension/README.md)

## Build from source

MCAP Slice requires a C++17 compiler, CMake, and Qt 6 Widgets. The MCAP, LZ4,
and Zstandard sources required by the application are included in the
repository.

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel
ctest --test-dir build --output-on-failure
```

Platform-specific prerequisites and commands are documented in
[Build from source](docs/BUILDING.md).

## Community and license

Use [GitHub Issues](https://github.com/TANG617/MCAP-Slice/issues) for confirmed
bugs and feature requests. Read [Support](SUPPORT.md) before filing a question,
and report security vulnerabilities through the process in
[SECURITY.md](SECURITY.md).

MCAP Slice is available under the [MIT License](LICENSE). It originated as a
fork of
[facontidavide/mcap_editor](https://github.com/facontidavide/mcap_editor);
the original author's copyright and license are preserved. See
[Third-party notices](THIRD_PARTY_NOTICES.md) for bundled dependencies.
