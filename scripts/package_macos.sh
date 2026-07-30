#!/usr/bin/env bash

set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target_arch="${MACOS_ARCH_LABEL:-$(uname -m)}"
build_dir="${BUILD_DIR:-${project_dir}/build/release-macos-${target_arch}}"
dist_dir="${DIST_DIR:-${project_dir}/dist}"
stage_dir="${dist_dir}/.stage-macos-${target_arch}"
app_path="${stage_dir}/MCAP Slice.app"
dmg_path="${dist_dir}/MCAP-Slice-macOS-${target_arch}.dmg"

case "${target_arch}" in
  arm64|x86_64) ;;
  *)
    echo "Unsupported macOS architecture: ${target_arch}" >&2
    exit 1
    ;;
esac

if [[ -n "${QT_PREFIX:-}" ]]; then
  qt_prefix="${QT_PREFIX}"
elif [[ -n "${QT_ROOT_DIR:-}" ]]; then
  qt_prefix="${QT_ROOT_DIR}"
elif command -v brew >/dev/null 2>&1; then
  qt_prefix="$(brew --prefix qtbase)"
else
  echo "Set QT_PREFIX or QT_ROOT_DIR to a Qt 6 installation." >&2
  exit 1
fi

macdeployqt="${qt_prefix}/bin/macdeployqt"

if [[ ! -x "${macdeployqt}" ]]; then
  echo "macdeployqt was not found at ${macdeployqt}." >&2
  exit 1
fi

cmake \
  -S "${project_dir}" \
  -B "${build_dir}" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_PREFIX_PATH="${qt_prefix}" \
  -DCMAKE_OSX_ARCHITECTURES="${target_arch}" \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=12.0 \
  -DBUILD_TESTING=ON
cmake --build "${build_dir}" --parallel
ctest --test-dir "${build_dir}" --output-on-failure

mkdir -p "${dist_dir}"
rm -rf "${stage_dir}"
mkdir -p "${stage_dir}"
cp -R "${build_dir}/MCAP Slice.app" "${app_path}"

deploy_args=(-always-overwrite)
if [[ -n "${MACOS_SIGNING_IDENTITY:-}" ]]; then
  required_notary_values=(
    "${APPLE_NOTARY_KEY_PATH:-}"
    "${APPLE_NOTARY_KEY_ID:-}"
    "${APPLE_NOTARY_ISSUER_ID:-}"
  )
  for value in "${required_notary_values[@]}"; do
    if [[ -z "${value}" ]]; then
      echo "Signing requires the App Store Connect notarization credentials." >&2
      exit 1
    fi
  done
  if [[ ! -f "${APPLE_NOTARY_KEY_PATH}" ]]; then
    echo "Notarization key not found: ${APPLE_NOTARY_KEY_PATH}" >&2
    exit 1
  fi
  deploy_args+=("-sign-for-notarization=${MACOS_SIGNING_IDENTITY}")
else
  deploy_args+=("-codesign=-")
fi

"${macdeployqt}" "${app_path}" "${deploy_args[@]}"

app_executable="${app_path}/Contents/MacOS/MCAP Slice"
app_architectures="$(lipo -archs "${app_executable}")"
case " ${app_architectures} " in
  *" ${target_arch} "*) ;;
  *)
    echo "Expected ${target_arch}, found: ${app_architectures}" >&2
    exit 1
    ;;
esac

codesign --verify --deep --strict --verbose=2 "${app_path}"

rm -f "${dmg_path}"
hdiutil create \
  -volname "MCAP Slice" \
  -srcfolder "${app_path}" \
  -ov \
  -format UDZO \
  "${dmg_path}"

if [[ -n "${MACOS_SIGNING_IDENTITY:-}" ]]; then
  codesign \
    --force \
    --sign "${MACOS_SIGNING_IDENTITY}" \
    --timestamp \
    "${dmg_path}"
  codesign --verify --strict --verbose=2 "${dmg_path}"

  xcrun notarytool submit "${dmg_path}" \
    --key "${APPLE_NOTARY_KEY_PATH}" \
    --key-id "${APPLE_NOTARY_KEY_ID}" \
    --issuer "${APPLE_NOTARY_ISSUER_ID}" \
    --wait
  xcrun stapler staple "${dmg_path}"
  xcrun stapler validate "${dmg_path}"
  spctl \
    --assess \
    --type open \
    --context context:primary-signature \
    --verbose=2 \
    "${dmg_path}"
fi

hdiutil verify "${dmg_path}"

echo "Created:"
echo "  ${app_path}"
echo "  ${dmg_path}"
