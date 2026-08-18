# VS Code extension smoke matrix

Run this checklist before publishing a VSIX. Use an indexed recording with a
ROS 2 CDR `sensor_msgs/msg/CompressedImage` stream and at least one ordinary
message topic.

| Environment | Open by default | Frame preview | Export/reopen | Source change/Reload |
| --- | --- | --- | --- | --- |
| macOS local | Verified during v0.1.0 development | Verified | Verified | Verified |
| Windows local | Pending manual release check | Pending | Pending | Pending |
| Linux local | Covered by CI integration; confirm UI manually | Pending | Pending | Covered by CI |
| Remote - SSH | Pending manual release check | Pending | Pending | Pending |
| WSL | Pending manual release check | Pending | Pending | Pending |
| Dev Container | Pending manual release check | Pending | Pending | Pending |

For each environment:

1. Install `mcap-slice-vscode.vsix` and open an indexed `.mcap` from the
   Explorer. Confirm the tab uses **MCAP Slice** without **Reopen Editor With…**.
2. Confirm recording details, Topic counts, and Schema text appear; no topic is
   initially selected.
3. Select a compatible video stream, drag quickly across several frames, and
   confirm only the final frame is shown without continuous playback.
4. Export a short `[In, Out)` selection in Zstandard, LZ4, and None modes. Open
   each result and check Topic counts, Metadata, and provenance.
5. Touch or replace the source file. Confirm export becomes disabled and
   **Reload Source** clears the stale state.
6. Cancel a longer export and confirm there is no destination or temporary
   `.mcap-slice-*.tmp` file.
7. For remote environments, confirm both source and destination remain on the
   remote workspace host and no browser or external service receives data.
