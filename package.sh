#!/usr/bin/env bash
# Fallback packager: assembles the flashable module zip by hand, in case the
# `:module:packageZygiskModule` Gradle task doesn't match your AGP version's
# ndkBuild output layout.
#
# Usage:
#   1. cd module && ndk-build NDK_PROJECT_PATH=. APP_BUILD_SCRIPT=./jni/Android.mk \
#        NDK_APPLICATION_MK=./jni/Application.mk
#      (or: ./gradlew :module:externalNativeBuildRelease)
#   2. cd .. && ./package.sh
#
# Output: out/zygisk_isolationpolicy.zip

set -euo pipefail
cd "$(dirname "$0")"

MODULE_ID="zygisk_isolationpolicy"
STAGE="$(mktemp -d)"
OUT_DIR="out"

cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

echo "== staging module skeleton =="
cp -r module/flash/. "$STAGE/"
mkdir -p "$STAGE/zygisk"

echo "== locating compiled libs =="
found=0
for abi in armeabi-v7a arm64-v8a x86 x86_64; do
    so=""
    # ndk-build direct output
    for cand in \
        "module/libs/$abi/libisolationpolicy.so" \
        $(find module/build -path "*/$abi/libisolationpolicy.so" 2>/dev/null); do
        if [ -f "$cand" ]; then so="$cand"; break; fi
    done
    if [ -n "$so" ]; then
        cp "$so" "$STAGE/zygisk/$abi.so"
        echo "  $abi <- $so"
        found=$((found + 1))
    else
        echo "  $abi: not found, skipping"
    fi
done

if [ "$found" -eq 0 ]; then
    echo "ERROR: no compiled libisolationpolicy.so found for any ABI." >&2
    echo "Build first, e.g.: cd module && ndk-build NDK_PROJECT_PATH=. \\" >&2
    echo "  APP_BUILD_SCRIPT=./jni/Android.mk NDK_APPLICATION_MK=./jni/Application.mk" >&2
    exit 1
fi

mkdir -p "$OUT_DIR"
( cd "$STAGE" && zip -r -q "$OLDPWD/$OUT_DIR/$MODULE_ID.zip" . )
echo "== wrote $OUT_DIR/$MODULE_ID.zip =="
