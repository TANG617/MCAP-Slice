# VS Code extension smoke matrix

Run this checklist before publishing a VSIX. Use an indexed recording with a
ROS 2 CDR `sensor_msgs/msg/CompressedImage` stream, a ROS 2 CDR
`sensor_msgs/msg/JointState` stream, and at least one ordinary message topic.
Also prepare a local URDF whose model contains an HTTPS mesh with an external
texture or buffer.

| Environment | Open by default | Video + robot sync | HTTPS assets | Export/reopen | Source change/Reload |
| --- | --- | --- | --- | --- | --- |
| macOS local | Verified during v0.1.0 development | Pending | Pending | Verified | Verified |
| Windows local | Pending manual release check | Pending | Pending | Pending | Pending |
| Linux local | Covered by CI integration; confirm UI manually | Pending | Pending | Pending | Covered by CI |
| Remote - SSH | Pending manual release check | Pending | Pending | Pending | Pending |
| WSL | Pending manual release check | Pending | Pending | Pending | Pending |
| Dev Container | Pending manual release check | Pending | Pending | Pending | Pending |

For each environment:

1. Install `mcap-slice-vscode.vsix` and open an indexed `.mcap` from the
   Explorer. Confirm the tab uses **MCAP Slice** without **Reopen Editor With…**.
2. Confirm Video and Robot previews remain side by side when the editor is made
   narrow (horizontal scrolling is acceptable; vertical reordering is not).
   Confirm the lower area gives most width to range/Export while Topics,
   compression, and details remain in the narrow disclosure sidebar. Verify the
   active VS Code theme accent is used consistently in both dark and light themes.
   Drag the lower divider to widen Topics, resize it with Left/Right Arrow while
   focused, switch editor tabs and confirm its width is retained, then
   double-click it to restore the default width.
3. Select a compatible video stream, drag quickly across several frames, and
   confirm only the final frame is shown without continuous playback.
4. Load the URDF, approve its HTTPS origin for this load, and confirm the mesh
   and its external texture or buffer appear. Rejecting the origin must leave
   MCAP inspection, video, and export usable.
5. Select the JointState stream. Drag video frames and the In/Out range
   controls; confirm the robot uses the last JointState at or before the shared
   `log_time`, never a future pose. Repeat with no compatible video selected.
6. Select export topics and specific Video/JointState streams, then open another
   MCAP whose matching topics use different channel IDs. Confirm all three topic
   choices and the remembered URDF restore without another HTTPS prompt or
   visible network rebuild. If a saved topic is absent, confirm the current MCAP
   falls back without forgetting the saved topic. Clear the robot asset cache
   and confirm the model is fetched again after approval.
7. Export a short `[In, Out)` selection in Zstandard, LZ4, and None modes. Open
   each result and check Topic counts, Metadata, and provenance.
8. Touch or replace the source file. Confirm export becomes disabled and
   **Reload Source** clears the stale state.
9. Cancel a longer export and confirm there is no destination or temporary
   `.mcap-slice-*.tmp` file.
10. For remote environments, confirm source, destination, local URDF access,
    and HTTPS asset downloads occur on the remote extension host. Confirm the
    Webview makes no direct external request.
