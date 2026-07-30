#!/usr/bin/env bash

set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build_dir="${BUILD_DIR:-${project_dir}/build/release-linux-x86_64}"
dist_dir="${DIST_DIR:-${project_dir}/dist}"
app_dir="${dist_dir}/.stage-linux-x86_64/AppDir"
output_path="${dist_dir}/MCAP-Slice-Ubuntu-x86_64.AppImage"
tools_dir="${LINUXDEPLOY_TOOLS_DIR:-${build_dir}/linuxdeploy-tools}"

linuxdeploy_version="1-alpha-20251107-1"
linuxdeploy_sha256="c20cd71e3a4e3b80c3483cef793cda3f4e990aca14014d23c544ca3ce1270b4d"
qt_plugin_version="1-alpha-20250213-1"
qt_plugin_sha256="15106be885c1c48a021198e7e1e9a48ce9d02a86dd0a1848f00bdbf3c1c92724"

download_and_verify()
{
  local url="$1"
  local destination="$2"
  local expected_sha256="$3"
  local temporary="${destination}.download"

  if [[ -f "${destination}" ]] &&
     echo "${expected_sha256}  ${destination}" | sha256sum --check --status; then
    return
  fi

  rm -f "${temporary}" "${destination}"
  curl \
    --location \
    --fail \
    --show-error \
    --silent \
    --retry 3 \
    --output "${temporary}" \
    "${url}"
  echo "${expected_sha256}  ${temporary}" | sha256sum --check
  mv "${temporary}" "${destination}"
  chmod +x "${destination}"
}

qt_prefix="${QT_PREFIX:-${QT_ROOT_DIR:-}}"
cmake_args=(
  -S "${project_dir}"
  -B "${build_dir}"
  -DCMAKE_BUILD_TYPE=Release
  -DBUILD_TESTING=ON
)
if [[ -n "${qt_prefix}" ]]; then
  cmake_args+=("-DCMAKE_PREFIX_PATH=${qt_prefix}")
fi
if command -v ninja >/dev/null 2>&1; then
  cmake_args+=(-G Ninja)
fi

cmake "${cmake_args[@]}"
cmake --build "${build_dir}" --parallel
ctest --test-dir "${build_dir}" --output-on-failure

rm -rf "${app_dir}"
mkdir -p "${app_dir}" "${dist_dir}" "${tools_dir}"
DESTDIR="${app_dir}" cmake --install "${build_dir}" --prefix /usr

desktop_file="${app_dir}/usr/share/applications/mcap-slice.desktop"
icon_file="${app_dir}/usr/share/icons/hicolor/scalable/apps/mcap-slice.svg"
if [[ ! -f "${desktop_file}" || ! -f "${icon_file}" ]]; then
  echo "The AppDir is missing its desktop file or icon." >&2
  exit 1
fi

if [[ -n "${LINUXDEPLOY_BIN:-}" ]]; then
  linuxdeploy_bin="${LINUXDEPLOY_BIN}"
else
  linuxdeploy_bin="${tools_dir}/linuxdeploy-x86_64.AppImage"
  download_and_verify \
    "https://github.com/linuxdeploy/linuxdeploy/releases/download/${linuxdeploy_version}/linuxdeploy-x86_64.AppImage" \
    "${linuxdeploy_bin}" \
    "${linuxdeploy_sha256}"
fi

plugin_entrypoint="${tools_dir}/linuxdeploy-plugin-qt"
if [[ -n "${LINUXDEPLOY_PLUGIN_QT:-}" ]]; then
  cp "${LINUXDEPLOY_PLUGIN_QT}" "${plugin_entrypoint}"
  chmod +x "${plugin_entrypoint}"
else
  download_and_verify \
    "https://github.com/linuxdeploy/linuxdeploy-plugin-qt/releases/download/${qt_plugin_version}/linuxdeploy-plugin-qt-x86_64.AppImage" \
    "${plugin_entrypoint}" \
    "${qt_plugin_sha256}"
fi

if [[ -n "${qt_prefix}" ]]; then
  if [[ -x "${qt_prefix}/bin/qmake6" ]]; then
    export QMAKE="${qt_prefix}/bin/qmake6"
  elif [[ -x "${qt_prefix}/bin/qmake" ]]; then
    export QMAKE="${qt_prefix}/bin/qmake"
  fi
fi

rm -f "${output_path}"
export ARCH=x86_64
export APPIMAGE_EXTRACT_AND_RUN=1
export OUTPUT="${output_path}"
export PATH="${tools_dir}:${PATH}"

"${linuxdeploy_bin}" \
  --appdir "${app_dir}" \
  --desktop-file "${desktop_file}" \
  --icon-file "${icon_file}" \
  --plugin qt \
  --output appimage

chmod +x "${output_path}"
file "${output_path}" | grep -q "x86-64"

smoke_log="${build_dir}/appimage-smoke.log"
QT_QPA_PLATFORM=offscreen "${output_path}" >"${smoke_log}" 2>&1 &
smoke_pid=$!
sleep 3
if ! kill -0 "${smoke_pid}" 2>/dev/null; then
  smoke_exit=0
  wait "${smoke_pid}" || smoke_exit=$?
  cat "${smoke_log}" >&2
  echo "The AppImage exited during the smoke test with code ${smoke_exit}." >&2
  exit 1
fi
kill "${smoke_pid}"
wait "${smoke_pid}" 2>/dev/null || true

echo "Created:"
echo "  ${app_dir}"
echo "  ${output_path}"
