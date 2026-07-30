# Contributing to MCAP Slice

Thank you for helping improve MCAP Slice.

By participating, you agree to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Before starting

- Search [existing issues](https://github.com/TANG617/MCAP-Slice/issues) before
  opening a new one.
- Use the Bug Report form for reproducible defects and the Feature Request form
  for product proposals.
- For a substantial behavior or interface change, open an issue first so the
  expected user experience and MCAP compatibility can be agreed on.
- Do not post private recordings, credentials, personal data, or sensitive
  vulnerability details in a public issue.

Security reports follow [SECURITY.md](SECURITY.md), not the public issue
tracker.

## Development setup

Read [Building MCAP Slice](docs/BUILDING.md) for platform prerequisites and
[Development and Architecture](docs/DEVELOPMENT.md) for the data flow.

A normal local validation run is:

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel
ctest --test-dir build --output-on-failure
```

## Pull requests

Keep each pull request focused on one coherent change. Before requesting
review:

1. build the application from a clean build directory;
2. run all CTest tests;
3. exercise the changed workflow with a non-sensitive MCAP fixture;
4. update user, architecture, provenance, or build documentation when behavior
   changes;
5. add a concise entry under **Unreleased** in `CHANGELOG.md`; and
6. check that no generated build output or local path was added to Git.

Follow the existing C++ formatting in `.clang-format`. Preserve Qt native
controls and platform behavior unless the change explicitly requires
otherwise.

## Testing MCAP changes

Relevant test cases include:

- empty, summary-less, malformed, and large recordings;
- inclusive In and exclusive Out boundaries;
- duplicate channels with one topic name;
- rapid switching between files in one folder;
- compatible and incompatible video streams;
- top-level Metadata preservation; and
- repeated slicing that appends, rather than replaces, provenance.

Use synthetic or redistributable fixtures. A screenshot or test asset must not
contain identifiable people, customer environments, machine usernames,
absolute source paths, or proprietary topic data.

## Documentation

English documentation is canonical. Keep `README.zh-CN.md` and the Chinese User
Guide behaviorally aligned when user-facing workflow or limitations change.

Use relative links for files inside the repository. Link to GitHub Releases
rather than hard-coding a release version or asset filename.

## Licensing

By submitting a contribution, you agree that it may be distributed under the
project's [MIT License](LICENSE). Preserve upstream notices when modifying
vendored code and update [Third-party notices](THIRD_PARTY_NOTICES.md) when a
dependency changes.
