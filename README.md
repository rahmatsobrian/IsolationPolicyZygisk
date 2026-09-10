# Isolation Policy — Zygisk port

A standalone **Zygisk** experiment (no LSPosed/Xposed required) based on the
LSPosed module `Isolation-Policy` by mhmrdd. It identifies app-zygote launches
for apps selected through a built-in WebUI.
Built on top of the official `zygisk-module-sample` template/scaffold — the
Gradle/NDK layout, `Android.mk`, `Application.mk`, and `zygisk.hpp` are all
unmodified from that template.

## Why this isn't a 1:1 line-for-line port

The original module hooks the Java method `ProcessList.startProcessLocked`
inside `system_server`, using ART method hooking supplied by the LSPosed
framework. **Plain Zygisk has no such hooking engine** — `zygisk.hpp` only
exposes JNI native-method hooking and native PLT/inline hooking, neither of
which can intercept an arbitrary Java method. Reimplementing an ART hook by
hand would mean hard-coding `ArtMethod` struct offsets per Android
version/ABI: fragile, and easy to silently break on a device the module
wasn't tested on.

This port can observe the relevant launch using only the public Zygisk API:

- Zygisk calls `preAppSpecialize()` after the app-zygote process is forked but
  before specialization.
- `is_child_zygote` identifies the app-zygote launch and the package is
  resolved from its process name.
- The package is checked against the on-disk denylist through the root
  companion when the zygote SELinux domain cannot read `/data/adb`.

The callback is too late to reproduce the original module by preventing the
fork. Killing the process from `preAppSpecialize()` makes `system_server`
retain stale AppZygote lifecycle state until its timeout, causing immediate
relaunches to hang or force-close. Instead, denied app zygotes stay alive and
the module hooks the native `Class.classForName()` implementation. A class
implementing `android.app.ZygotePreload` is rejected before initialization;
Android handles that reflective load failure and completes the app-zygote
startup protocol normally without calling `ZygotePreload.doPreload()`.

This differs observably from the original LSPosed hook. The isolated service
can still start, so a checker may report that its app-zygote preload was not
called rather than timing out. The protected operation is the same: selected
packages cannot execute their `ZygotePreload` implementation.

## Project layout

```
isolationpolicy-zygisk/
├── build.gradle.kts, settings.gradle.kts, gradlew...   # unmodified sample scaffold
├── module/
│   ├── build.gradle.kts        # ndkBuild wiring + packageZygiskModuleRelease/Debug tasks
│   ├── jni/
│   │   ├── Android.mk          # unmodified template, just renamed target
│   │   ├── Application.mk      # unmodified template
│   │   ├── zygisk.hpp          # unmodified public Zygisk API header
│   │   └── isolation_policy.cpp   # <- the actual ported logic (IP_DEBUG-gated logging)
│   ├── src/main/AndroidManifest.xml   # empty, required by AGP library module
│   └── flash/                  # flashable module skeleton (zipped as-is)
│       ├── module.prop
│       ├── customize.sh        # creates /data/adb/isolationpolicy/denied.list
│       ├── uninstall.sh
│       ├── META-INF/...        # standard Magisk installer stub
│       └── webroot/            # the WebUI (Material Design 3 + dynamic color)
│           ├── index.html
│           ├── style.css
│           ├── bridge.js       # root-shell exec bridge (ksu.exec)
│           ├── app.js          # list apps, edit denylist, save, status/log panels
│           └── build-info.js   # placeholder; regenerated per build by Gradle
└── package.sh                  # fallback manual packager (produces a release-flavored zip)
```

## How the policy is stored

`/data/adb/isolationpolicy/denied.list` — one package name per line.
Deliberately **outside** `/data/adb/modules/<id>/`, because that directory
gets wiped and re-extracted on every module update; keeping the policy file
elsewhere means updating the module never resets your denylist.

- **Native module** first tries to read this file on each relevant
  `preAppSpecialize` call, then uses the root companion when SELinux denies
  direct access from the zygote domain.
- **WebUI** writes this file by running root shell commands through the
  `ksu.exec()` bridge exposed by KernelSU / APatch / MMRL WebUI-X (which
  recent Magisk WebUI implementations also target) — again no companion
  needed for the same reason (the exec bridge itself already runs as root).

The `REGISTER_ZYGISK_COMPANION` handler in `isolation_policy.cpp` performs
that privileged policy lookup.

## Release vs debug builds

`isolation_policy.cpp` compiles to two independent flavors, controlled by
the `IP_DEBUG` preprocessor macro (set per Gradle build type in
`module/build.gradle.kts`, via `externalNativeBuild.ndkBuild.cFlags`):

|                      | Release (`IP_DEBUG=0`)                          | Debug (`IP_DEBUG=1`)                                  |
|----------------------|--------------------------------------------------|--------------------------------------------------------|
| Logcat volume        | Minimal — only module load, denylist hits, and real errors/warnings | Verbose — every `preAppSpecialize()` call, every resolved package name, every denylist line scanned |
| Module id            | `zygisk_isolationpolicy`                          | `zygisk_isolationpolicy_debug`                          |
| Output zip           | `out/zygisk_isolationpolicy.zip`                  | `out/zygisk_isolationpolicy-debug.zip`                  |
| Intended use          | Daily use                                        | Troubleshooting (`logcat -s IsolPolicyZygisk`, or the WebUI's "View recent logs" panel) |

Because the two flavors use different module IDs, both can be flashed side
by side if you ever want to compare them. CI (`.github/workflows/build.yml`)
builds and uploads both on every run, and attaches both zips to tagged
releases.

## Building

Requires the `libcxx` git submodule from the original template (already
wired up in `Android.mk`/`.gitmodules`):

```bash
git submodule update --init --recursive
```

**Known upstream issue:** recent `topjohnwu/libcxx` snapshots implement
`std::__countr_zero`/`std::__countl_zero` using the generic builtins
`__builtin_ctzg`/`__builtin_clzg`, which Clang 19 (NDK 28.2.13676358) doesn't
recognize yet — this breaks any translation unit that pulls in `<algorithm>`
(including `isolation_policy.cpp`, indirectly via `std::string`) with
`error: use of undeclared identifier '__builtin_ctzg'`. Patch it once after
fetching the submodule:

```bash
python3 scripts/patch_libcxx_builtins.py module/jni/libcxx/include
```

The script rewrites those two calls to the classic per-width builtins
(`__builtin_ctz`/`ctzl`/`ctzll`, `__builtin_clz`/`clzl`/`clzll`) that all
Clang versions support — the same implementation libc++ used before its
generic-builtin migration. It's idempotent, so re-running it (or running it
in CI on every build) is safe. The CI workflow
(`.github/workflows/build.yml`) already runs this step automatically.

Then either:

```bash
# Release (minimal logging)
./gradlew :module:externalNativeBuildRelease :module:packageZygiskModuleRelease
# -> out/zygisk_isolationpolicy.zip

# Debug (verbose logging)
./gradlew :module:externalNativeBuildDebug :module:packageZygiskModuleDebug
# -> out/zygisk_isolationpolicy-debug.zip
```

or, if your AGP version's ndkBuild output path doesn't match what the
Gradle task expects, build with `ndk-build` directly and use the fallback
script (note: `package.sh` doesn't set `IP_DEBUG`, so it always produces a
release-style zip; pass `APP_CFLAGS=-DIP_DEBUG=1` to `ndk-build` yourself
first if you want a debug .so out of this path):

```bash
cd module
ndk-build NDK_PROJECT_PATH=. APP_BUILD_SCRIPT=./jni/Android.mk NDK_APPLICATION_MK=./jni/Application.mk
cd ..
./package.sh
# -> out/zygisk_isolationpolicy.zip
```

## Installing

1. Enable Zygisk (Magisk: Settings → Zygisk, or install ReZygisk /
   NeoZygisk / BreZygisk if your Magisk build dropped Zygisk, or use
   KernelSU/APatch which ship it built-in).
2. Flash `zygisk_isolationpolicy.zip` (or the `-debug` build if you're
   troubleshooting) in your root manager, reboot.
3. Open the module's **Action/WebUI** button in your root manager. The
   WebUI shows install stats and lets you tick the apps you want to deny
   isolated/app-zygote services for; tap **Apply changes** to save. Tap the
   ⓘ icon for module/device status, native-lib presence per ABI, an
   enable/disable toggle, and a built-in recent-logs viewer.

## Known limitations

- Requires a genuinely working `ksu.exec`-style WebUI bridge in your root
  manager to use the WebUI. If it's missing, you can still edit
  `/data/adb/isolationpolicy/denied.list` by hand (one package name per
  line) from any root shell.
- This implementation suppresses `ZygotePreload`, but does not suppress the
  app-zygote fork itself. Exact parity with the original module's service
  timeout behavior requires its pre-fork `system_server` ART hook.
- Denying your own launcher/critical system-adjacent app's isolated
  services can break that app; the WebUI only lists third-party apps
  (`pm list packages -3`) to reduce that risk, matching the original
  module's user-vs-system app distinction.
