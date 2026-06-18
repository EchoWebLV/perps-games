# Building the Redline 3D APK (Seeker / Android)

Capacitor wraps the Vite web build into a native Android app. The pipeline is:

```
vite build  →  cap sync android  →  gradlew assembleDebug  →  app-debug.apk
```

All of that is one command: **`npm run apk`**.

---

## Build & install (every time)

```bash
cd redline3d
npm run apk            # → android/app/build/outputs/apk/debug/app-debug.apk
npm run apk:serve      # build, then serve over Wi-Fi to download & tap-install (no USB)
npm run apk:install    # build, then `adb install -r` to a USB device (needs USB debugging)
```

`apk:serve` is the route that works on the Seeker: it prints a
`http://<your-lan-ip>:8077/redline.apk` URL — open it in the phone's browser
(same Wi-Fi), download, tap, and allow "install unknown apps". Ctrl+C to stop the
server. (USB/`adb` needs USB debugging enabled on the phone, which can be fiddly.)

`npm run apk` reuses the debug keystore, so the APK is installable immediately
(no signing needed for testing). After any code change just run it again — the
build re-bundles the web app and re-syncs it into the Android project.

### Put it on the Seeker

**Over USB (fastest, repeatable):**
1. On the Seeker: Settings → About → tap *Build number* 7× to unlock Developer
   options, then enable **USB debugging**.
2. Plug it into the Mac, approve the RSA fingerprint prompt on the phone.
3. `npm run apk:install` (or `adb install -r android/app/build/outputs/apk/debug/app-debug.apk`).
4. Launch **Redline 3D** from the app drawer.

**Without a cable:** copy `app-debug.apk` to the phone (AirDrop to Files, a
USB-C drive, or upload somewhere), tap it, and allow "install from unknown
sources" when prompted.

---

## One-time machine setup

Already done on this machine. To reproduce on another Mac (Homebrew, no sudo):

```bash
brew install openjdk@21                          # JDK 21 (Capacitor 8 requires 21)
brew install --cask android-commandlinetools     # sdkmanager / adb

export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
yes | sdkmanager --sdk_root="$ANDROID_HOME" --licenses
sdkmanager --sdk_root="$ANDROID_HOME" "platform-tools" "platforms;android-36" "build-tools;36.0.0"
```

`scripts/build-apk.sh` sets `JAVA_HOME` and `ANDROID_HOME` to these Homebrew
locations by default. If yours differ, export them before running `npm run apk`,
or add them to your shell profile:

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
```

---

## Notes

- **App identity** lives in `capacitor.config.ts` (`appId: xyz.redline.game`,
  `appName: Redline 3D`). Change the `appId` to a domain you control **before**
  the first store release — changing it later makes Android treat it as a
  different app.
- **APK size:** the GLB car models in `public/models/` are bundled into the APK
  (`orion.glb` alone is ~39 MB). Fine for testing; trim/optimize before release.
- **Network:** the live price feed needs internet — Capacitor's generated
  `AndroidManifest.xml` already includes the `INTERNET` permission.
- **Release / dApp Store build (later):** create a keystore, add a `signingConfig`
  to `android/app/build.gradle`, and run `./gradlew assembleRelease` (or
  `bundleRelease` for an `.aab`). Then it can go to the Solana dApp Store, and
  Mobile Wallet Adapter can be wired in for the token.
- `android/` is a generated Gradle project; its `build/`, `.gradle/`, and
  `local.properties` are gitignored. Commit the rest so the project is
  reproducible.
