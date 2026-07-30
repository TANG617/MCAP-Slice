# Provenance Metadata

[Project home](../README.md) · [User Guide](USER_GUIDE.md)

Every successful export appends one top-level MCAP Metadata record named:

```text
mcap_slice.provenance.v1
```

The record describes the immediate source used for that export. Existing
top-level Metadata is written first in source order, including any older MCAP
Slice provenance records. Slicing an exported file therefore creates a
traceable chain without rewriting previous entries.

## Fields

All keys and values use strings, as required by MCAP Metadata.

| Key | Meaning |
| --- | --- |
| `tool.name` | `MCAP Slice` |
| `tool.version` | Application version that created this slice |
| `source.file_name` | Immediate source basename; never an absolute path |
| `source.file_size_bytes` | Immediate source size in bytes |
| `source.message_start_time` | Minimum source log time as ISO text |
| `source.message_start_time_ns` | Exact minimum source log time in epoch ns |
| `source.message_end_time` | Maximum source log time as ISO text |
| `source.message_end_time_ns` | Exact maximum source log time in epoch ns |
| `slice.start_time` | Inclusive selected In boundary as canonical ISO text |
| `slice.start_time_ns` | Inclusive selected In boundary in epoch nanoseconds |
| `slice.end_time_exclusive` | Exclusive selected Out boundary as ISO text |
| `slice.end_time_exclusive_ns` | Exclusive selected Out in epoch ns |
| `slice.selected_topics_json` | Sorted exported topics as compact JSON |
| `slice.created_at` | Export creation time as canonical ISO text |

Canonical ISO strings use millisecond precision and the `Asia/Shanghai` offset:

```text
2026-07-30T04:06:56.682+08:00
```

The `_ns` fields are decimal epoch nanoseconds. Source message nanoseconds are
copied without passing through the millisecond UI representation. Slice
boundaries reflect the editor's millisecond precision and are therefore
multiples of 1,000,000 nanoseconds.

## Boundary semantics

The exported message interval is:

```text
[slice.start_time_ns, slice.end_time_exclusive_ns)
```

The start is inclusive and the end is exclusive. `source.message_end_time`
has a different meaning: it is the exact maximum log time of a message in the
immediate source and is not an exclusive boundary.

The selected topic array includes only topic names that exist in the current
source and are actually exported. Topic names remembered from other files in a
folder session are not written when absent from the current source.

## Example

```json
{
  "tool.name": "MCAP Slice",
  "tool.version": "<application version>",
  "source.file_name": "demo-session-01.mcap",
  "source.file_size_bytes": "88171995",
  "source.message_start_time": "2026-07-30T04:06:53.421+08:00",
  "source.message_start_time_ns": "1785355613421322451",
  "source.message_end_time": "2026-07-30T04:07:02.516+08:00",
  "source.message_end_time_ns": "1785355622516666485",
  "slice.start_time": "2026-07-30T04:06:54.000+08:00",
  "slice.start_time_ns": "1785355614000000000",
  "slice.end_time_exclusive": "2026-07-30T04:07:02.000+08:00",
  "slice.end_time_exclusive_ns": "1785355622000000000",
  "slice.selected_topics_json": "[\"/camera/front/color/compressed\",\"/robot/joint_states\"]",
  "slice.created_at": "2026-07-30T12:00:00.000+08:00"
}
```

The example is illustrative. Values come from the selected source and range at
export time.

## Metadata preservation failure

MCAP Slice reads source top-level Metadata while loading the recording. If any
indexed Metadata record cannot be read or parsed, preview remains available,
but export is blocked. This prevents a successful-looking output from silently
dropping part of its provenance.

## Privacy and integrity boundaries

- Only the source basename is recorded; the source directory is never stored.
- No source SHA-256 is calculated.
- The application does not claim that a basename uniquely identifies a file.
- The provenance record documents the operation; it is not a cryptographic
  signature.
- Attachments are not copied by the current exporter.
