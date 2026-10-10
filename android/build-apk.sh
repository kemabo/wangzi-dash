#!/usr/bin/env bash
# 打安卓 APK（免 Gradle）。沙盒里 Node 的 spawnSync 会 EBUSY，所以改用 shell 直接调工具链。
set -euo pipefail

BIN="C:/Users/admin/.workbuddy/binaries"
JDK="$BIN/jdk17/jdk-17.0.20.1+1"
SDK="$BIN/android-sdk"
BT="$SDK/build-tools/34.0.0"
PLATFORM="$SDK/platforms/android-34/android.jar"
PY="$BIN/python/versions/3.13.12/python.exe"
SYS32="C:/Windows/System32"

export JAVA_HOME="$JDK"
export PATH="$SYS32:C:/Windows:$JDK/bin:$PATH"

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HERE/app-src"
OUT="$HERE/out"
KS="$HERE/release.keystore"
FINAL="$HERE/王子鞋服经营数据.apk"

echo "== 1/7 编译资源 =="
rm -rf "$OUT"; mkdir -p "$OUT"
"$BT/aapt2.exe" compile --dir "$APP/res" -o "$OUT/res.zip"

echo "== 2/7 链接并生成 R.java =="
mkdir -p "$OUT/gen"
"$BT/aapt2.exe" link -o "$OUT/base.apk" -I "$PLATFORM" \
  --manifest "$APP/AndroidManifest.xml" --java "$OUT/gen" --auto-add-overlay "$OUT/res.zip"

echo "== 3/7 javac =="
mkdir -p "$OUT/classes"
SRCS=$(find "$APP/src" "$OUT/gen" -name '*.java')
"$JDK/bin/javac.exe" -source 11 -target 11 -encoding UTF-8 -nowarn \
  -classpath "$PLATFORM" -d "$OUT/classes" $SRCS 2>&1 | tail -3

echo "== 4/7 d8 =="
mkdir -p "$OUT/dex"
CLASSES=$(find "$OUT/classes" -name '*.class')
"$JDK/bin/java.exe" -cp "$BT/lib/d8.jar" com.android.tools.r8.D8 --release --min-api 24 \
  --lib "$PLATFORM" --output "$OUT/dex" $CLASSES 2>&1 | tail -3

echo "== 5/7 打包 dex + assets =="
"$PY" - "$OUT/base.apk" "$OUT/packed.apk" "$APP/assets" "$OUT/dex/classes.dex" <<'PYEOF'
import sys, os, zipfile
src, dst, assets_dir, dex = sys.argv[1:5]
zin = zipfile.ZipFile(src)
zout = zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED)
for it in zin.infolist():
    zout.writestr(it, zin.read(it.filename))
zout.write(dex, "classes.dex")
n = 0
for root, dirs, files in os.walk(assets_dir):
    for f in files:
        p = os.path.join(root, f)
        zout.write(p, "assets/" + os.path.relpath(p, assets_dir).replace(os.sep, "/"))
        n += 1
zout.close()
print("   打包完成 %.1f KB，assets %d 个" % (os.path.getsize(dst)/1024, n))
PYEOF

echo "== 6/7 zipalign =="
"$BT/zipalign.exe" -f 4 "$OUT/packed.apk" "$OUT/aligned.apk"

echo "== 7/7 签名 =="
if [ ! -f "$KS" ]; then
  "$JDK/bin/keytool.exe" -genkeypair -keystore "$KS" -storepass wangzi2026 -keypass wangzi2026 \
    -alias wangzi -keyalg RSA -keysize 2048 -validity 10950 \
    -dname "CN=WangZi Dash, OU=WangZi, O=WangZi, L=CN, S=CN, C=CN" 2>&1 | tail -2
fi
rm -f "$FINAL"
"$JDK/bin/java.exe" -cp "$BT/lib/apksigner.jar" com.android.apksigner.ApkSignerTool sign \
  --ks "$KS" --ks-pass pass:wangzi2026 --key-pass pass:wangzi2026 --out "$FINAL" "$OUT/aligned.apk"
"$JDK/bin/java.exe" -cp "$BT/lib/apksigner.jar" com.android.apksigner.ApkSignerTool verify --print-certs -v "$FINAL" 2>&1 | head -12

echo "完成：$FINAL"
ls -l "$FINAL"
