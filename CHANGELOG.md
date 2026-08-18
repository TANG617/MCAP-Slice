# Changelog

All notable changes to MCAP Slice are documented in this file.

The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). A release version is
intentionally not assigned here; the publishing workflow will move the
appropriate entries out of **Unreleased**.

## Unreleased

### Added

- Standalone Qt 6/CMake desktop application that does not require ROS.
- Video-style dual-handle range selection with editable In and Out timestamps.
- Strict RFC 3339 timestamp entry and canonical `Asia/Shanghai` display.
- On-demand preview for compatible ROS 2 CDR
  `sensor_msgs/msg/CompressedImage` streams.
- Non-recursive folder sessions with native file navigation and live updates.
- Session-level topic selection that follows matching topic names across
  recordings.
- Duplicate-channel synchronization for channels that share a topic name.
- Background recording summary loading with stale-result protection.
- Zstandard, LZ4, and uncompressed export modes.
- Preservation of source top-level Metadata.
- `mcap_slice.provenance.v1` records with source bounds, slice bounds, exported
  topics, and creation time.
- Native macOS application metadata, icon, self-contained app packaging, and
  DMG creation support.
- Automated tests for timestamp parsing, offsets, precision, and validation.
- VS Code 1.95+ read-only custom editor with indexed local/remote workspace
  access, topic/schema inspection, single-frame video preview, safe streaming
  export, source-change detection, and VSIX packaging.
- Tag-driven VS Code extension validation and VSIX artifact packaging for
  manual Visual Studio Marketplace uploads.

### Changed

- Reworked the original editor into the MCAP Slice product and native
  three-pane workflow.
- Topic selection now starts empty; an explicit check is required for export.
- Export writes through `QSaveFile` and refuses to overwrite the source.
- The Export action now sits beside the Export range controls.
- The raster icon used by the application and extension now preserves the SVG's
  transparent outer background.

### Known limitations

- MCAP attachments are not copied.
- Video preview is limited to Qt-decodable ROS 2 CDR
  `sensor_msgs/msg/CompressedImage` payloads.
- Folder browsing is non-recursive.
- Time-range editing has millisecond precision.
