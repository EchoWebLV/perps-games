#!/usr/bin/env bash
# Perps Rider APK build pipeline (Capacitor + Android Gradle).
#
#   ./scripts/build-apk.sh            build a debug APK
#   ./scripts/build-apk.sh --install  build + adb install -r to a USB device (needs USB debugging)
#   ./scripts/build-apk.sh --serve    build + serve over LAN so a phone can download & tap-install
#                                      (the no-USB route — what works on the Seeker)
#
# Toolchain paths default to the Homebrew install; override by exporting
# JAVA_HOME / ANDROID_HOME before running.
set -euo pipefail
cd "$(dirname "$0")/.."   # -> redline3d/

export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
SERVE_PORT="${SERVE_PORT:-8077}"

# Vite silently falls back when an ignored .env file is missing. That is unsafe for the APK:
# Solana's anonymous devnet RPC rejects Capacitor's https://localhost origin, and a missing Privy
# id leaves native sign-in unusable. Fail before building instead of producing a broken release.
require_vite_env() {
  local name="$1"
  if [ -n "${!name:-}" ]; then return 0; fi
  local env_file
  for env_file in .env .env.local .env.production .env.production.local; do
    if [ -f "$env_file" ] && grep -Eq "^${name}=.+$" "$env_file"; then return 0; fi
  done
  echo "Missing $name: refusing to build a native APK with incomplete sign-in configuration." >&2
  exit 1
}

require_vite_env VITE_PRIVY_APP_ID
require_vite_env VITE_BASE_RPC

if [ -n "${VITE_API_BASE:-}" ] && node -e '
  const { isIP } = require("node:net");
  let hostname;
  try {
    hostname = new URL(process.env.VITE_API_BASE).hostname.toLowerCase();
  } catch {
    process.exit(1);
  }
  const host = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  const isLoopback = host === "localhost"
    || (isIP(host) === 4 && host.startsWith("127."))
    || (isIP(host) === 6 && host === "::1");
  process.exit(isLoopback ? 0 : 1);
'; then
  echo "Invalid VITE_API_BASE=$VITE_API_BASE: loopback API endpoints are invalid for APK builds." >&2
  exit 1
fi

INSTALL=0
SERVE=0
for arg in "$@"; do
  if [ "$arg" = "--install" ]; then INSTALL=1; fi
  if [ "$arg" = "--serve" ]; then SERVE=1; fi
done

if [ ! -x "$JAVA_HOME/bin/java" ]; then
  echo "✗ JDK not found at JAVA_HOME=$JAVA_HOME — see BUILD_APK.md (one-time setup)." >&2
  exit 1
fi
if [ ! -x "$ANDROID_HOME/platform-tools/adb" ]; then
  echo "✗ Android SDK not found at ANDROID_HOME=$ANDROID_HOME — see BUILD_APK.md." >&2
  exit 1
fi

# Gradle locates the SDK via local.properties (gitignored); write it if missing.
[ -f android/local.properties ] || echo "sdk.dir=$ANDROID_HOME" > android/local.properties

echo "▶ 1/4  building web bundle (vite)…"
npm run build

echo "▶ 2/4  making the game the native root…"
node scripts/prepare-native-assets.mjs dist

echo "▶ 3/4  syncing game-only web assets into the android project…"
npx --yes cap sync android

echo "▶ 4/4  assembling debug APK (gradle)…"
( cd android && ./gradlew --console=plain assembleDebug )

APK="android/app/build/outputs/apk/debug/app-debug.apk"
echo ""
echo "✅ APK built: $(pwd)/$APK"
ls -lh "$APK"

if [ "$INSTALL" = "1" ]; then
  echo ""
  echo "▶ installing to connected device…"
  if [ -z "$(adb devices | sed -n '2p')" ]; then
    echo "✗ no device detected. Enable USB debugging on the Seeker, plug it in," >&2
    echo "  approve the RSA prompt, then re-run with --install." >&2
    exit 1
  fi
  adb install -r "$APK"
  echo "✅ installed. Launch 'Perps Rider' from the Seeker app drawer."
fi

if [ "$SERVE" = "1" ]; then
  IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo 'YOUR-LAN-IP')"
  DIR="$(mktemp -d)"
  cp "$APK" "$DIR/perps-rider.apk"
  echo ""
  echo "📲 On the phone (same Wi-Fi) open Chrome and go to:"
  echo "      http://$IP:$SERVE_PORT/perps-rider.apk"
  echo "   Download → tap → allow 'install unknown apps' → Install."
  echo "   (Ctrl+C to stop the server once it's installed.)"
  echo ""
  ( cd "$DIR" && python3 -m http.server "$SERVE_PORT" --bind 0.0.0.0 )
fi
