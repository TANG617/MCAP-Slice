# MCAP Slice User Guide

[English](USER_GUIDE.md) · [简体中文](USER_GUIDE.zh-CN.md) ·
[Project home](../README.md)

## 1. Open recordings

Use **Open MCAP…** for one recording, drag one `.mcap` file onto the window, or
use **Open Folder…** for a folder session.

A folder session lists only `.mcap` files directly inside that folder.
Subfolders are not scanned. Select a file with the mouse or arrow keys; loading
and video indexing happen in the background, so the file list remains
responsive.

Opening a standalone file closes the folder session. Opening a new folder,
opening a standalone file, or restarting the application clears the topic
selection.

## 2. Select topics

All topics start unchecked. Check only the topic names that should appear in
the exported MCAP.

- The selection is remembered by full topic name within the current folder
  session.
- When another file contains the same topic, that topic is restored as
  checked.
- A selected topic that is missing from the current file remains remembered
  and reappears as checked when a matching file is selected later.
- Duplicate channels with the same topic name are synchronized and exported
  together.
- **Clear selection** removes the current folder session's complete selection.
- The **Export…** button is enabled only when the current file is loaded, the
  range is valid, and at least one selected topic exists in that file.

Selecting a row displays its schema in **Selected topic schema**. Row selection
does not change its checkbox.

## 3. Preview video

When a recording contains compatible streams, MCAP Slice selects the best
matching color stream and indexes its timestamps. Use the stream menu to select
a different preview channel.

Preview requires:

- ROS 2 CDR message encoding;
- schema `sensor_msgs/msg/CompressedImage`; and
- a compressed image format that Qt can decode.

The player provides play/pause, frame seeking, elapsed time, image dimensions,
pixel format, ROS frame ID, and capture time. Frames are decoded on demand.

The preview stream is independent from export selection. Previewing a topic
does not check it, and clearing the export selection does not disable preview.

## 4. Set the export range

Drag the two range handles or edit the **In** and **Out** fields.

Canonical timestamps look like:

```text
2026-07-30T04:06:56.682+08:00
```

The editor:

- always displays `Asia/Shanghai` (`+08:00`);
- accepts RFC 3339 timestamps with `Z` or `±HH:mm`;
- accepts one to nine fractional digits and truncates beyond milliseconds;
- rejects text without a timezone; and
- keeps the previous valid value after invalid input.

**In** is inclusive. **Out** is exclusive, so a message whose log time is
exactly equal to Out is not exported. Use **Reset** to restore the complete
range of the current recording.

## 5. Export

Choose one compression mode:

- **ZSTD** for a strong general-purpose default;
- **LZ4** for faster compression and decompression; or
- **None** when compression is not desired.

Select **Export…**, choose a new `.mcap` path, and wait for the export to
complete. Canceling leaves no partial destination file. MCAP Slice refuses to
overwrite the source.

The exported file contains only messages whose channel topic is selected and
whose log time falls within `[In, Out)`.

## 6. Traceability and Metadata

MCAP Slice preserves source schemas, selected channels, channel Metadata, and
all source top-level Metadata. It then appends one
`mcap_slice.provenance.v1` record.

That record contains the immediate source filename without its directory,
source file size, exact source message bounds in nanoseconds, selected slice
bounds, exported topic names, tool version, and creation time. Slicing an
already sliced file preserves the older record and appends another one.

See [Provenance Metadata](PROVENANCE.md) for the complete field contract.

## Troubleshooting

### Export is disabled

Wait for the file to finish loading, make sure In is earlier than Out, and
check at least one topic that exists in the current file.

### A timestamp is rejected

Include an explicit timezone, for example `Z` or `+08:00`, and use the RFC 3339
date-time separator `T`.

### No video is shown

The MCAP may not contain a compatible ROS 2 CDR `CompressedImage` channel, or
Qt may not support the payload's image codec. Topic export still works.

### Export stops because Metadata cannot be preserved

Preview remains available when a top-level Metadata record cannot be parsed,
but export is intentionally blocked to prevent silently dropping provenance.

### A file is missing from the folder list

Only regular `.mcap` files in the selected folder's first level are shown.
Nested files and other extensions are ignored.

### Attachments are missing

Attachments are not copied by the current exporter. Keep the original
recording and verify every exported file before deleting source data.

For unresolved problems, follow [Support](../SUPPORT.md).
