# Development and Architecture

[Project home](../README.md) · [Build from source](BUILDING.md) ·
[Contributing](../CONTRIBUTING.md)

## Technology

MCAP Slice is a C++17 Qt 6 Widgets application. It uses the MCAP C++ reader and
writer directly and does not depend on ROS at runtime. LZ4 and Zstandard are
built as static dependencies.

The main application target is defined in `CMakeLists.txt`. Qt's AUTOUIC,
AUTOMOC, and AUTORCC generate the UI, meta-object, and resource code.

## Main components

- `MainWindow` coordinates file and folder sessions, topic selection, range
  editing, preview tasks, and export.
- `RecordingSnapshot` is plain data returned by background summary loading. It
  contains statistics, schemas, channels, channel counts, source top-level
  Metadata, and any Metadata preservation error.
- `IsoDateTimeEdit` provides strict RFC 3339 parsing and canonical
  `Asia/Shanghai` display.
- `TimeRangeSlider` provides the dual-handle In/Out editor.
- `VideoPreviewWidget` owns stream selection, playback controls, frame state,
  and presentation.
- `Ros2CompressedImageDecoder` reads the CDR representation of
  `sensor_msgs/msg/CompressedImage`.
- `QIODeviceInterface` adapts `QSaveFile` to the MCAP writer.

## Recording load flow

1. Opening a file increments a monotonically increasing file-load generation.
2. The UI enters a loading state and disables export.
3. A `QThreadPool` task opens the MCAP, reads its summary with fallback scan,
   and builds a `RecordingSnapshot`.
4. The result returns to the GUI thread through a queued invocation.
5. The result is applied only if its generation still matches. A result from a
   file that the user has already switched away from is discarded.

Folder browsing uses `QFileSystemModel` and a native `QListView`. The model is
filtered to regular `.mcap` files in the selected root. It remains active while
summary loading occurs.

## Topic selection

The session-level selection is a set of complete topic strings. It is empty for
a new standalone file or folder session and is not persisted in `QSettings`.

When a snapshot is applied, each channel is checked only when its topic exists
in that set. User changes update the set and synchronize every row with the
same topic. Programmatic table population is protected by a fill flag and
`QSignalBlocker`.

Video stream selection is stored separately and never mutates the export set.

## Video indexing and decoding

Compatible channels are discovered from schema and message encoding. A
background task collects timestamps and small frame descriptors, not image
payloads. Playback requests decode only the selected frame.

Video work has its own generation. Switching files or streams invalidates
older indexing and decode results. At most one frame decode is active; a newer
requested frame replaces the pending request.

## Export flow

Export validates the loaded file, range, Metadata preservation state, and
current topic selection. It then:

1. registers the required schemas and selected channels with new IDs;
2. reads messages for selected topics in `[In, Out)`;
3. writes messages with remapped channel IDs;
4. writes every preserved source top-level Metadata record;
5. appends `mcap_slice.provenance.v1`; and
6. closes and commits the `QSaveFile`.

Cancelation or any writer/reader error cancels the temporary output. The source
path is rejected as a destination.

See [Provenance Metadata](PROVENANCE.md) for the exported field contract.

## Desktop and WebAssembly boundaries

Desktop builds support file paths, drag-and-drop, background file loading, and
folder browsing. The existing WebAssembly compile-time path uses browser file
upload/download and hides desktop folder and video UI. WebAssembly is not a
documented end-user release platform.

## Settings

`QSettings` stores splitter geometry and the most recent open/save
directories. It does not store selected topics or source recording data.

## Tests and review

The CTest target covers ISO timestamp parsing, timezone conversion,
nanosecond-to-millisecond truncation, invalid input, and editor formatting.

Changes to loading, selection, video, or export should also be checked with:

- an empty folder and a folder containing several MCAP files;
- rapid file switching;
- duplicate channels with one topic name;
- a compatible `CompressedImage` recording;
- an MCAP containing top-level Metadata; and
- two consecutive slices to confirm provenance chaining.

Follow [CONTRIBUTING.md](../CONTRIBUTING.md) before opening a pull request.
