# Pull request

## Summary

Describe the user-visible or maintenance outcome.

## Changes

- Describe the main code or documentation changes.

## Validation

- [ ] Configured and built from a clean build directory
- [ ] Ran `ctest --test-dir build --output-on-failure`
- [ ] Tested the affected workflow with synthetic or redistributable MCAP data
- [ ] Added or updated tests where practical
- [ ] Updated `CHANGELOG.md` under **Unreleased**
- [ ] Updated relevant user, build, architecture, or provenance documentation
- [ ] Confirmed no private data or absolute local paths were added
- [ ] Confirmed no generated build output was added

## MCAP compatibility

Describe any effect on time boundaries, topic/channel selection, compression,
schemas, Metadata, provenance, attachments, or existing files. Write “None” if
the change cannot affect MCAP input or output.

## Screenshots

For UI changes, include screenshots made with synthetic or redistributable
data. Write “Not applicable” otherwise.
