#!/usr/bin/env bash
# 編桌面 app 隨附的最小 ffmpeg／ffprobe（vault plan「MeetPilot · 跨平台打包部署」E2）。
#
#   scripts/ffmpeg/build.sh <mac-arm64|mac-x64|win-x64>
#
# 輸出到 vendor/ffmpeg/<目標>/，electron-builder 依平台與架構打進安裝檔。
# 只開 server 用得到的東西（configure-flags.txt）：音訊解碼、容器、WAV 輸出、重採樣。沒有 --enable-gpl，
# 也沒有任何外部函式庫，授權是 LGPL 2.1 以上；configure 的輸出不是「License: LGPL version 2.1 or later」就失敗。
# 輸出目錄附 LICENSE-ffmpeg.txt（LGPL 全文）與 NOTICE-ffmpeg.txt（版本、原始碼取得方式、configure 參數、
# 連進執行檔的 MIT 授權檔案聲明），electron-builder 一起打進安裝檔。
# 原始碼固定版本並驗 sha256；有 gpg 的環境（CI）另外驗官方簽章，金鑰指紋釘死。
# macOS 在 Apple Silicon 上交叉編 x64；Windows 在 MSYS2 的 MINGW64 殼裡跑，靜態連結，不依賴 mingw 的 DLL。
set -euo pipefail

TARGET="${1:?用法：scripts/ffmpeg/build.sh <mac-arm64|mac-x64|win-x64>}"
VERSION=8.1.3
SHA256=7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3
KEY_FINGERPRINT=FCF986EA15E6E293A5644F10B4322F04D67658D8  # gitleaks:allow FFmpeg 官方簽章公鑰的指紋，公開資料，釘死是為了驗簽章

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
  echo "ffmpeg-${VERSION}.tar.xz 的 sha256 是 ${actual}，預期 ${SHA256}，拒絕編譯。" >&2
  echo "如果是上次下載到一半的殘檔，刪掉 ${TARBALL} 再跑一次；刪了還是不符就不要編" >&2
  exit 1
fi
if command -v gpg >/dev/null; then
  curl -sSfL -o "$TARBALL.asc" "https://ffmpeg.org/releases/ffmpeg-$VERSION.tar.xz.asc"
  GNUPGHOME="$(mktemp -d)"; export GNUPGHOME
  trap 'rm -rf "$GNUPGHOME"' EXIT
  curl -sSfL https://ffmpeg.org/ffmpeg-devel.asc | gpg --batch --quiet --import
  # 狀態先存進變數再比對：gpg 直接 pipe 給 grep -q 的話，grep 提早結束會讓 gpg 吃到 SIGPIPE，pipefail 當成失敗
  # gpg 自己的錯誤訊息另存：網路、匯入或簽章錯誤時要看得到原因，不能只剩一句「不是金鑰簽的」
  gpg_err="$GNUPGHOME/verify.err"
  status=$(gpg --batch --quiet --verify --status-fd 1 "$TARBALL.asc" "$TARBALL" 2>"$gpg_err" || true)
  # 比對要錨定在 VALIDSIG 那一行的指紋欄位：GOODSIG 那行帶簽章者的 user ID，UID 裡夾著這串指紋的假金鑰
  # 用沒錨定的 grep 也會過。金鑰被撤銷或過期時 gpg 仍可能印 VALIDSIG，所以另外拒絕這兩種
  if ! printf '%s\n' "$status" | grep -q "^\[GNUPG:\] VALIDSIG ${KEY_FINGERPRINT} "; then
    echo "ffmpeg-${VERSION} 的簽章不是金鑰 ${KEY_FINGERPRINT} 簽的，拒絕編譯。gpg 的輸出：" >&2
    cat "$gpg_err" >&2
    exit 1
  fi
  if printf '%s\n' "$status" | grep -qE "^\[GNUPG:\] (REVKEYSIG|EXPKEYSIG|EXPSIG|BADSIG|ERRSIG) "; then
    echo "ffmpeg-${VERSION} 的簽章狀態有問題（撤銷、過期或錯誤），拒絕編譯：" >&2
    printf '%s\n' "$status" | grep -E "REVKEYSIG|EXPKEYSIG|EXPSIG|BADSIG|ERRSIG" >&2
    exit 1
  fi
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
# ${EXTRA[@]+"${EXTRA[@]}"}：bash 4.4 以前空陣列在 set -u 下展開會報 unbound variable
./configure "${FLAGS[@]}" ${EXTRA[@]+"${EXTRA[@]}"} > configure.log 2>&1 || { tail -30 configure.log; exit 1; }
grep -q "^License: LGPL version 2.1 or later" configure.log || { grep "^License" configure.log; echo "授權不是 LGPL 2.1+，拒絕" >&2; exit 1; }
make -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)" > make.log 2>&1 || { tail -30 make.log; exit 1; }

# Windows：確認只依賴系統內建的 DLL。漏了 -static 的話會依賴 mingw 的 libwinpthread／libgcc，
# 記錄人電腦上沒有，雙擊就是「找不到 DLL」。用白名單不用黑名單：mingw 的 DLL 名字列不完。
# kernel32.dll 一定要出現，沒有代表 objdump 沒讀到匯入表，檢查等於空過
if [ "$TARGET" = "win-x64" ]; then
  deps=$(objdump -p "ffmpeg$EXE" "ffprobe$EXE" | awk '/DLL Name:/ {print tolower($3)}' | sort -u)
  echo "DLL 依賴：$(echo $deps)"
  printf '%s\n' "$deps" | grep -qx 'kernel32.dll' || { echo "objdump 沒列出 kernel32.dll，讀不到匯入表，拒絕" >&2; exit 1; }
  allowed='^(kernel32|msvcrt|ucrtbase|bcrypt|advapi32|user32|shell32|ole32|oleaut32|psapi|ws2_32|secur32|crypt32|ntdll|api-ms-win-[a-z0-9-]+)\.dll$'
  bad=$(printf '%s\n' "$deps" | grep -vE "$allowed" || true)
  [ -z "$bad" ] || { echo "依賴了不在白名單裡的 DLL：$bad" >&2; exit 1; }
fi

rm -rf "$OUT" && mkdir -p "$OUT"
cp "ffmpeg$EXE" "ffprobe$EXE" "$OUT/"
cp COPYING.LGPLv2.1 "$OUT/LICENSE-ffmpeg.txt"
# LGPL 2.1 §4 要附原始碼或對等的取得方式；另外附上連進執行檔的 MIT 授權檔案聲明
{
  echo "MeetPilot 隨附 FFmpeg ${VERSION}（ffmpeg、ffprobe），授權 LGPL 2.1 以上，全文見 LICENSE-ffmpeg.txt。"
  echo "FFmpeg 是 FFmpeg 開發者的作品，https://ffmpeg.org/"
  echo
  echo "原始碼：https://ffmpeg.org/releases/ffmpeg-${VERSION}.tar.xz"
  echo "sha256：${SHA256}"
  echo "官方簽章金鑰指紋：${KEY_FINGERPRINT}"
  echo "建置方式：MeetPilot 原始碼的 scripts/ffmpeg/build.sh（目標 ${TARGET}），未修改 FFmpeg 原始碼。configure 參數："
  printf '  %s\n' "${FLAGS[@]}" ${EXTRA[@]+"${EXTRA[@]}"}
  echo
  echo "以下檔案以 MIT 授權釋出，依授權附上其聲明："
  # 這三個是 8.1.3 連進執行檔的 MIT 授權檔案（以 nm 確認過）。awk 以 /* … */ 為一段擷取含授權文字的註解，
  # 註解內剛好出現 */ 字樣時會截短而計數檢查照樣通過；升 ffmpeg 版本時要重新確認清單與擷取結果
  for f in libavformat/oggdec.c libavformat/oggparsevorbis.c libavutil/avsscanf.c; do
    echo
    echo "--- $f ---"
    awk '/\/\*/{buf=""; inb=1} inb{buf=buf $0 "\n"} /\*\//{ if (inb && buf ~ /Permission is hereby granted/) { printf "%s", buf; exit } inb=0 }' "$f"
  done
  echo
  echo "--- FFmpeg 的 LICENSE.md ---"
  cat LICENSE.md
} > "$OUT/NOTICE-ffmpeg.txt"
grep -c "Permission is hereby granted" "$OUT/NOTICE-ffmpeg.txt" | grep -qx 3 \
  || { echo "NOTICE-ffmpeg.txt 沒有擷取到三份 MIT 聲明，拒絕" >&2; exit 1; }
echo "ffmpeg ${VERSION}（${TARGET}，LGPL 2.1+）→ $OUT"
ls -l "$OUT"
