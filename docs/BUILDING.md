# Building MCAP Slice

[Project home](../README.md) · [User Guide](USER_GUIDE.md) ·
[Development](DEVELOPMENT.md)

## Requirements

All desktop builds require:

- CMake 3.16 or later;
- a C++17 compiler; and
- Qt 6 with the Widgets module.

MCAP C++, LZ4, and Zstandard are vendored in this repository. ROS, colcon, and
a ROS workspace are not required.

## macOS

The application declares macOS 12 as its minimum system version.

Install the build tools with Homebrew:

```bash
brew install cmake qtbase
```

Configure, build, and test:

```bash
cmake -S . -B build \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_PREFIX_PATH="$(brew --prefix qtbase)"
cmake --build build --parallel
ctest --test-dir build --output-on-failure
open "build/MCAP Slice.app"
```

The resulting architecture follows the compiler and Qt installation used for
the build. Build on Apple Silicon for arm64 and on an Intel environment for
x86_64.

To create a self-contained local application and DMG:

```bash
./scripts/package_macos.sh
```

This command uses `macdeployqt` and writes its results under `dist/`. Local
packages may not be Developer ID signed or notarized. Release signing and
publication are handled separately from this build guide.

## Windows

Install:

- Visual Studio 2022 Build Tools with the **Desktop development with C++**
  workload;
- CMake; and
- the Qt 6 MSVC 2022 64-bit component.

From a Developer PowerShell, replace the Qt path with the installed version:

```powershell
cmake -S . -B build `
  -DCMAKE_PREFIX_PATH="C:/Qt/6.x.x/msvc2022_64"
cmake --build build --config Release --parallel
ctest --test-dir build -C Release --output-on-failure
.\build\Release\mcap-slice.exe
```

These commands build the application from source. End-user Windows packages
published on GitHub Releases include the required Qt runtime separately from
the source tree.

## Ubuntu

Install the compiler, CMake, and Qt 6 development packages:

```bash
sudo apt update
sudo apt install \
  build-essential \
  cmake \
  libgl1-mesa-dev \
  libxkbcommon-dev \
  qt6-base-dev
```

Configure, build, test, and run:

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel
ctest --test-dir build --output-on-failure
./build/mcap-slice
```

For normal desktop use, download the AppImage from
[GitHub Releases](https://github.com/TANG617/MCAP-Slice/releases), make it
executable, and run it:

```bash
chmod +x MCAP-Slice*.AppImage
./MCAP-Slice*.AppImage
```

## Common CMake options

Use a separate build directory for each configuration or architecture.

```bash
cmake -S . -B build-debug -DCMAKE_BUILD_TYPE=Debug
cmake -S . -B build-release -DCMAKE_BUILD_TYPE=Release
```

Tests are enabled by default through CTest. To configure an application-only
build:

```bash
cmake -S . -B build -DBUILD_TESTING=OFF
```

## Troubleshooting

### CMake cannot find Qt 6

Set `CMAKE_PREFIX_PATH` to the Qt installation prefix. On macOS,
`brew --prefix qtbase` prints the correct value. On Windows, select the
directory containing the Qt `lib/cmake` hierarchy.

### The application starts without a platform plugin

Source builds require the Qt platform plugins from the same Qt installation
used at link time. End-user release packages bundle the required plugins.

### Video preview cannot decode a frame

Verify that the Qt installation includes an image format plugin for the
compressed payload, such as JPEG. This does not prevent non-video topics from
being exported.

### A fresh checkout is missing vendored source

Use a complete source archive or clone of this repository. The versioned
dependency directories under `3rdparty/` must be present before configuring
CMake.
