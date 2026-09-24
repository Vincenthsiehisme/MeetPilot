#!/usr/bin/env bash
# 編桌面 app 隨附的最小 ffmpeg／ffprobe（vault plan「MeetPilot · 跨平台打包部署」E2）。
#
#   scripts/ffmpeg/build.sh <mac-arm64|mac-x64|win-x64>
#
# 輸出到 vendor/ffmpeg/<目標>/，electron-builder 依平台與架構打進安裝檔。
# 只開 server 用得到的東西（configure-flags.txt）：音訊解碼、容器、WAV 輸出、重採樣。沒有 --enable-gpl，
# 也沒有任何外部函式庫，授權是 LGPL 2.1 以上；腳本最後會驗 `ffmpeg -L` 真的是 LGPL，不是就失敗。
# 原始碼固定版本並驗 sha256；有 gpg 的環境（CI）另外驗官方簽章，金鑰指紋釘死。
# macOS 在 Apple Silicon 上交叉編 x64；Windows 在 MSYS2 的 MINGW64 殼裡跑，靜態連結，不依賴 mingw 的 DLL。
set -euo pipefail

TARGET="${1:?用法：scripts/ffmpeg/build.sh <mac-arm64|mac-x64|win-x64>}"
VERSION=8.1.3
SHA256=7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3
KEY_FINGERPRINT=FCF986EA15E6E293A5644F10B4322F04D67658D8

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$ROOT/vendor/ffmpeg/$TARGET"
WORK="$ROOT/vendor/.ffmpeg-build/$TARGET"
TARBALL="$ROOT/vendor/.ffmpeg-build/ffmpeg-$VERSION.tar.xz"

mkdir -p "$(dirname "$TARBALL")"
if [ ! -f "$TARBALL" ]; then
  curl -sSfL -o "$TARBALL.part" "https://ffmpeg.org/releases/ffmpeg-$VERSION.tar.xz"
  mv "$TARBALL.part" "$TARBALL"
fi
actual=$( (command -v sha256sum >/dev/null && sha256sum "$TARBALL" || shasum -a 256 "$TARBALL") | cut -d' ' -f1)
if [ "$actual" != "$SHA256" ]; then
  echo "ffmpeg-$VERSION.tar.xz 的 sha256 是 ${actual}，預期 ${SHA256}，拒絕編譯" >&2
  exit 1
fi
if command -v gpg >/dev/null; then
  curl -sSfL -o "$TARBALL.asc" "https://ffmpeg.org/releases/ffmpeg-$VERSION.tar.xz.asc"
  GNUPGHOME="$(mktemp -d)"; export GNUPGHOME
  curl -sSfL https://ffmpeg.org/ffmpeg-devel.asc | gpg --batch --quiet --import
  gpg --batch --quiet --verify --status-fd 1 "$TARBALL.asc" "$TARBALL" | grep -q "VALIDSIG $KEY_FINGERPRINT" \
    || { echo "ffmpeg-$VERSION 的簽章不是金鑰 $KEY_FINGERPRINT 簽的，拒絕編譯" >&2; exit 1; }
  echo "簽章驗過：$KEY_FINGERPRINT"
elif [ "${FFMPEG_REQUIRE_SIGNATURE:-}" = "1" ]; then
  # CI 設這個：沒有 gpg 就失敗，不能安靜地退成只驗 sha256
  echo "要求驗簽章（FFMPEG_REQUIRE_SIGNATURE=1），但這台沒有 gpg" >&2
  exit 1
else
  echo "（這台沒有 gpg，只驗 sha256；CI 會驗簽章）"
fi

rm -rf "$WORK" && mkdir -p "$WORK"
tar -xf "$TARBALL" -C "$WORK" --strip-components=1
cd "$WORK"

EXTRA=()
EXE=""
case "$TARGET" in
  mac-arm64) EXTRA=(--arch=arm64 --extra-cflags="-mmacosx-version-min=11.0" --extra-ldflags="-mmacosx-version-min=11.0") ;;
  mac-x64)   EXTRA=(--enable-cross-compile --arch=x86_64 --target-os=darwin --cc="clang -arch x86_64" --disable-x86asm \
                    --extra-cflags="-mmacosx-version-min=11.0" --extra-ldflags="-mmacosx-version-min=11.0") ;;
  win-x64)   EXTRA=(--arch=x86_64 --target-os=mingw32 --extra-ldflags="-static"); EXE=".exe" ;;
  *) echo "不認得的目標：$TARGET" >&2; exit 1 ;;
esac

# macOS 內建 bash 是 3.2，沒有 mapfile
FLAGS=()
while IFS= read -r line; do
  line="${line%$'\r'}"
  [ -n "$line" ] && FLAGS+=("$line")
done < "$HERE/configure-flags.txt"
./configure "${FLAGS[@]}" "${EXTRA[@]}" > configure.log 2>&1 || { tail -30 configure.log; exit 1; }
grep -q "^License: LGPL version 2.1 or later" configure.log || { grep "^License" configure.log; echo "授權不是 LGPL 2.1+，拒絕" >&2; exit 1; }
make -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)" > make.log 2>&1 || { tail -30 make.log; exit 1; }

# Windows：確認只依賴系統內建的 DLL。漏了 -static 的話會依賴 mingw 的 libwinpthread／libgcc，
# 記錄人電腦上沒有，雙擊就是「找不到 DLL」
if [ "$TARGET" = "win-x64" ]; then
  deps=$(objdump -p "ffmpeg$EXE" "ffprobe$EXE" | awk '/DLL Name:/ {print tolower($3)}' | sort -u)
  echo "DLL 依賴：$(echo $deps)"
  bad=$(echo "$deps" | grep -E '^(libwinpthread|libgcc|libstdc|zlib|libiconv|libbz2|liblzma)' || true)
  [ -z "$bad" ] || { echo "依賴了系統沒有的 DLL：$bad" >&2; exit 1; }
fi

rm -rf "$OUT" && mkdir -p "$OUT"
cp "ffmpeg$EXE" "ffprobe$EXE" "$OUT/"
cp COPYING.LGPLv2.1 "$OUT/LICENSE-ffmpeg.txt"
echo "ffmpeg ${VERSION}（${TARGET}，LGPL 2.1+）→ $OUT"
ls -l "$OUT"
