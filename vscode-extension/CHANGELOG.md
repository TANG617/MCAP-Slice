# Changelog

## Unreleased

- Added local URDF loading with relative, `package://`, and explicitly approved
  HTTPS mesh and texture dependencies.
- Added ROS 2 CDR JointState indexing and deterministic robot poses synchronized
  with video and range controls by MCAP `log_time`.
- Added responsive Three.js robot preview, per-workspace URDF restoration, and
  robot asset cache management.
- Serialized indexed MCAP reads so simultaneous video and JointState indexing
  cannot corrupt the shared message-index cursor.
- Reorganized the editor into a full-width video/robot preview row with Topics,
  range, compression, and Export controls grouped below it.
- Refined the layout using persistent side-by-side previews, a dominant
  range/Export surface, compact disclosures for occasional settings, and
  VS Code theme-derived accent colors with reduced-motion support.
- Added a draggable, keyboard-accessible splitter between Topics/settings and
  the primary export surface, including remembered width and double-click reset.
- Added per-workspace, cross-MCAP restoration of export topics, video topic, and
  JointState topic by topic name; URDF restoration remains enabled.
- Added reusable prepared-URDF bundles: unchanged HTTPS models now reopen from
  local cache, with 24-hour conditional revalidation and local-dependency
  invalidation.
- Fixed VSIX packaging on clean CI runners by creating the output directory
  before invoking `vsce`.

## 0.1.1

- Added tag-driven GitHub Actions validation and VSIX artifact packaging for
  manual Visual Studio Marketplace uploads.
- Changed the extension icon background from opaque white to transparent.

## 0.1.0

- Added an indexed, read-only MCAP custom editor for desktop VS Code.
- Added topic/schema inspection and millisecond `[In, Out)` range editing.
- Added on-demand ROS 2 CDR CompressedImage frame preview.
- Added streaming Zstandard, LZ4, and uncompressed export with provenance.
- Added source-change detection, cancelable safe output, tests, and VSIX
  packaging.
