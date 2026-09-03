# Isolation Policy — Zygisk port

A standalone **Zygisk** module (no LSPosed/Xposed required) ported from the
LSPosed module `Isolation-Policy` by mhmrdd. Blocks isolated / app-zygote
service processes for apps you choose, managed through a built-in WebUI.
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

Instead, this port reaches the same practical outcome using only the public
Zygisk API:

- Zygisk calls `preAppSpecialize()` for **every** process forked from
  zygote/app-zygote, including isolated service processes.
- We detect isolated processes purely from the target **uid range**
  (`appId` 90000-99999 — the same range Android itself uses for
  `Process.isIsolated()`), resolve the owning package from `app_data_dir`,
  and check it against an on-disk denylist.
- If denied, we `_exit(0)` the child immediately, before it finishes
  specializing.

**Net effect vs. the original:** apps on the denylist still end up with a
non-functional isolated/app-zygote service. The failure mode is different —
system_server sees a process that died right after forking, instead of a
`startProcessLocked` call that silently reports success without ever
forking — but the practical outcome for the target app is the same: its
isolated service never comes up. In exchange, this implementation has zero
dependency on ART internals and works unmodified across Android
versions/ABIs.

One intentional scope change: since Zygisk can't distinguish "isolated via
app-zygote" from "isolated the regular way" through its public args, this
module blocks **any** isolated service process for a denied package, not
just app-zygote-hosted ones (a superset of the original's scope).

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

- **Native module** reads this file directly on every `preAppSpecialize`
  call. `preAppSpecialize` still runs with zygote's (root) privilege, so no
  companion/root-daemon round trip is needed just to read it.
- **WebUI** writes this file by running root shell commands through the
  `ksu.exec()` bridge exposed by KernelSU / APatch / MMRL WebUI-X (which
  recent Magisk WebUI implementations also target) — again no companion
  needed for the same reason (the exec bridge itself already runs as root).

The `REGISTER_ZYGISK_COMPANION` hook in `isolation_policy.cpp` is present
but currently unused, reserved for anyone who wants to extend this with
richer status reporting later.

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
- Broader scope than the original (blocks all isolated processes for a
  denied package, not just app-zygote ones) — see above.
- Denying your own launcher/critical system-adjacent app's isolated
  services can break that app; the WebUI only lists third-party apps
  (`pm list packages -3`) to reduce that risk, matching the original
  module's user-vs-system app distinction.
