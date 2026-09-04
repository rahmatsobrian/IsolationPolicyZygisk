/*
 * Isolation Policy - standalone Zygisk port
 *
 * Ported from the LSPosed module "Isolation-Policy" which hooks
 * ProcessList.startProcessLocked in system_server to prevent the
 * app_zygote fork for denied packages.
 *
 * ---- HOW DirtySepolicy DETECTION WORKS ----
 * DirtySepolicy's AppZygote.java runs in the app_zygote process
 * (ZygotePreload.doPreload()) BEFORE any isolated service child is forked.
 * From the app_zygote domain it can query the kernel SELinux policies and
 * detect Magisk/KSU/ZygiskNext dirty rules. The detection cannot be bypassed
 * by killing isolated children later - it's too late.
 *
 * ---- CORRECT APPROACH ----
 * We must prevent the app_zygote process from being forked in the first
 * place. Zygisk's AppSpecializeArgs has an `is_child_zygote` flag that is
 * set to `true` when Android is about to specialize a process as an
 * app_zygote (not a regular isolated child).
 *
 * By checking `is_child_zygote == true` in preAppSpecialize() and calling
 * _exit() when the package is denied, we kill the app_zygote process before
 * doPreload() ever runs.
 *
 * ---- TWO BUILD FLAVORS: release vs debug ----
 * This source is compiled twice by the Gradle build (see module/build.gradle.kts
 * buildTypes), each defining the preprocessor macro IP_DEBUG:
 *
 *   Release (IP_DEBUG=0): only load/verdict/warning/error-level events are
 *   logged. preAppSpecialize() runs for EVERY process forked from zygote, so
 *   logging every single call at INFO would flood logcat on a normal phone;
 *   the release build stays quiet and only speaks up for denylist hits and
 *   real problems, keeping it light for daily use.
 *
 *   Debug (IP_DEBUG=1): every branch decision is logged at INFO/DEBUG level
 *   (visible without BuildConfig.DEBUG / without root shell -- just
 *   `logcat -s IsolPolicyZygisk`) so we can see exactly where the flow
 *   diverges:
 *     1. Does preAppSpecialize() get called AT ALL for the app_zygote fork?
 *        (some Zygisk providers, e.g. NeoZygisk/ZygiskNext, skip calling
 *        modules for isolated-range UIDs if the root daemon socket connect
 *        fails - app_zygote's own uid falls inside the isolated uid range)
 *     2. What is uid / nice_name / is_child_zygote / app_data_dir at that point?
 *     3. Does the policy file open, and what's actually in it?
 *     4. Does the package string match a denylist entry?
 */

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cerrno>
#include <cstdint>
#include <unistd.h>
#include <android/log.h>
#include <string>
#include <signal.h>

#include "zygisk.hpp"

using zygisk::Api;
using zygisk::AppSpecializeArgs;
using zygisk::ServerSpecializeArgs;

// Set by Gradle via externalNativeBuild.ndkBuild.cFlags per build type
// (see module/build.gradle.kts). Falls back to 0 (release-style, quiet) if
// this file is ever compiled outside that Gradle wiring, e.g. via a plain
// `ndk-build` invocation that doesn't pass -DIP_DEBUG=<0|1>.
#ifndef IP_DEBUG
#define IP_DEBUG 0
#endif

#define LOG_TAG "IsolPolicyZygisk"

// Always compiled in, both flavors: real events (denylist hits) and genuine
// problems (file/IPC errors). Kept minimal on purpose so release logcat
// output stays small.
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  LOG_TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN,  LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

// Verbose/tracing logs: every call's arguments, every scanned line, every
// "allowed" verdict, etc. Compiled to a no-op in release builds (IP_DEBUG=0)
// so they cost nothing at runtime and produce zero logcat spam; fully
// enabled in debug builds (IP_DEBUG=1) for troubleshooting.
#if IP_DEBUG
#define LOGD(...) __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG, __VA_ARGS__)
#else
#define LOGD(...) ((void) 0)
#endif

// Policy file stored outside the module dir so it survives module updates.
static const char *kPolicyFile = "/data/adb/isolationpolicy/denied.list";

// Extract the package name from an app data directory path.
// e.g. "/data/user/0/com.example.app" -> "com.example.app"
static std::string packageFromDataDir(const std::string &dataDir) {
    size_t pos = dataDir.find_last_of('/');
    if (pos == std::string::npos || pos + 1 >= dataDir.size()) return dataDir;
    return dataDir.substr(pos + 1);
}

// Check whether `pkg` is in the on-disk denylist.
// Re-reads the file every call so WebUI edits take effect immediately.
// Logs every line it reads and the final verdict, so a mismatch (typo,
// wrong case, extra whitespace, wrong file permissions) is visible directly
// in logcat instead of silently returning "not denied".
// outFileError is set to true only when the file itself could not be opened
// (permission/SELinux/missing), as opposed to simply not containing `pkg`.
// Callers use this to decide whether it's worth falling back to the
// companion process instead of trusting a plain "not denied" result.
static bool isPackageDenied(const std::string &pkg, bool *outFileError) {
    if (outFileError) *outFileError = false;
    if (pkg.empty()) {
        LOGW("isPackageDenied: empty package name, treating as not denied");
        return false;
    }

    FILE *f = fopen(kPolicyFile, "re");
    if (!f) {
        LOGE("isPackageDenied: fopen(%s) failed: %s (errno=%d) -- "
             "check file exists and this process's euid/SELinux domain can read it",
             kPolicyFile, strerror(errno), errno);
        if (outFileError) *outFileError = true;
        return false;
    }

    LOGD("isPackageDenied: opened %s, scanning for pkg=\"%s\"", kPolicyFile, pkg.c_str());

    bool denied = false;
    int lineNo = 0;
    char line[256];
    while (fgets(line, sizeof(line), f)) {
        lineNo++;
        size_t len = strlen(line);
        // strip trailing whitespace / CR / LF
        while (len > 0 && (line[len-1] == '\n' || line[len-1] == '\r' ||
                           line[len-1] == ' '  || line[len-1] == '\t')) {
            line[--len] = '\0';
        }
        if (len == 0 || line[0] == '#') {
            LOGD("isPackageDenied: line %d skipped (empty/comment): \"%s\"", lineNo, line);
            continue;
        }
        bool match = pkg.compare(0, std::string::npos, line, len) == 0;
        LOGD("isPackageDenied: line %d = \"%s\" (len=%zu) match=%s",
             lineNo, line, len, match ? "YES" : "no");
        if (match) {
            denied = true;
            break;
        }
    }
    fclose(f);

    // Denied verdicts are the actionable event -> always logged, even in
    // release. Plain "allowed" is the common case (fires for every
    // non-denied app_zygote spawn) -> debug-only, to keep release quiet.
    if (denied) {
        LOGI("isPackageDenied: pkg=\"%s\" lines_scanned=%d verdict=DENIED",
             pkg.c_str(), lineNo);
    } else {
        LOGD("isPackageDenied: pkg=\"%s\" lines_scanned=%d verdict=allowed",
             pkg.c_str(), lineNo);
    }
    return denied;
}

// Wire format to the companion: [uint32 len][len bytes of pkg name] -> [uint8 0/1]
// Ask whether `pkg` is denied by asking the root companion process to read
// the policy file on our behalf. This exists because preAppSpecialize()
// itself runs in the "zygote" SELinux domain (confirmed via logcat:
// fopen() on the policy file returns EACCES from that domain on this
// device), while the companion runs in the provider's own root daemon
// domain, which does have access to files under /data/adb.
static bool isPackageDeniedViaCompanion(Api *api, const std::string &pkg) {
    int fd = api->connectCompanion();
    if (fd < 0) {
        LOGW("isPackageDeniedViaCompanion: connectCompanion() failed (fd=%d)", fd);
        return false;
    }

    bool ok = true;
    uint32_t len = (uint32_t) pkg.size();
    ok = ok && write(fd, &len, sizeof(len)) == (ssize_t) sizeof(len);
    ok = ok && write(fd, pkg.data(), len) == (ssize_t) len;

    uint8_t result = 0;
    if (ok) {
        ssize_t n = read(fd, &result, sizeof(result));
        ok = (n == (ssize_t) sizeof(result));
    }
    close(fd);

    if (!ok) {
        LOGW("isPackageDeniedViaCompanion: IPC failed for pkg=\"%s\"", pkg.c_str());
        return false;
    }
    if (result) {
        LOGI("isPackageDeniedViaCompanion: pkg=\"%s\" companion verdict=DENIED", pkg.c_str());
    } else {
        LOGD("isPackageDeniedViaCompanion: pkg=\"%s\" companion verdict=allowed", pkg.c_str());
    }
    return result != 0;
}

class IsolationPolicyModule : public zygisk::ModuleBase {
public:
    void onLoad(Api *api, JNIEnv *env) override {
        this->api = api;
        this->env = env;
        LOGI("onLoad: module loaded into this process (pid=%d) build=%s",
             getpid(), IP_DEBUG ? "debug" : "release");
    }

    void preAppSpecialize(AppSpecializeArgs *args) override {
        // Unconditional log FIRST, before any branching or early return.
        // If this line never shows up in logcat while DirtySepolicy is being
        // launched, the Zygisk provider is not calling preAppSpecialize() for
        // that process at all (framework/scope-level issue, not a bug in the
        // logic below) -- see NeoZygisk's app_specialize_pre()/skip_zygiskd
        // path for one known cause on isolated-range UIDs.
        //
        // This fires for EVERY process forked from zygote (not just
        // app_zygote ones), so it's debug-only -- at INFO it would flood a
        // release build's logcat on a normal phone with dozens of lines per
        // app launch.
        jint uid = args->uid;
        const char *niceNameRaw = nullptr;
        if (args->nice_name != nullptr) {
            niceNameRaw = env->GetStringUTFChars(args->nice_name, nullptr);
        }
        LOGD("preAppSpecialize: ENTER pid=%d uid=%d nice_name=%s is_child_zygote_ptr=%p "
             "is_child_zygote_val=%s app_data_dir_ptr=%p",
             getpid(), (int) uid,
             niceNameRaw ? niceNameRaw : "(null)",
             (void *) args->is_child_zygote,
             (args->is_child_zygote != nullptr) ? (*args->is_child_zygote ? "true" : "false") : "(null ptr)",
             (void *) &args->app_data_dir);
        if (niceNameRaw != nullptr) {
            env->ReleaseStringUTFChars(args->nice_name, niceNameRaw);
        }

        // We only care about processes that are going to become an app_zygote.
        if (args->is_child_zygote == nullptr || !*args->is_child_zygote) {
            LOGD("preAppSpecialize: not an app_zygote spawn (is_child_zygote null or false) "
                 "-> unloading, letting specialize proceed normally");
            api->setOption(zygisk::Option::DLCLOSE_MODULE_LIBRARY);
            return;
        }

        // app_data_dir is the normal way to resolve the package name, but it
        // is NULL for the app_zygote fork itself (confirmed via logcat: it's
        // only populated for the isolated *children* the app_zygote spawns
        // later, not for the app_zygote process itself). When that happens,
        // fall back to nice_name, which Android always sets to
        // "<package>_zygote" for an app-zygote process (see
        // ActivityManagerService's app-zygote start path).
        std::string pkg;
        if (args->app_data_dir != nullptr) {
            const char *raw = env->GetStringUTFChars(args->app_data_dir, nullptr);
            std::string dataDir = raw ? raw : "";
            if (raw) env->ReleaseStringUTFChars(args->app_data_dir, raw);
            pkg = packageFromDataDir(dataDir);
            LOGD("preAppSpecialize: resolved_pkg from app_data_dir=\"%s\" -> \"%s\"",
                 dataDir.c_str(), pkg.c_str());
        }

        if (pkg.empty() && args->nice_name != nullptr) {
            const char *niceRaw = env->GetStringUTFChars(args->nice_name, nullptr);
            std::string niceName = niceRaw ? niceRaw : "";
            if (niceRaw) env->ReleaseStringUTFChars(args->nice_name, niceRaw);

            static const std::string kZygoteSuffix = "_zygote";
            if (niceName.size() > kZygoteSuffix.size() &&
                niceName.compare(niceName.size() - kZygoteSuffix.size(),
                                  kZygoteSuffix.size(), kZygoteSuffix) == 0) {
                pkg = niceName.substr(0, niceName.size() - kZygoteSuffix.size());
                LOGD("preAppSpecialize: app_data_dir was null, resolved_pkg from "
                     "nice_name=\"%s\" (stripped _zygote) -> \"%s\"",
                     niceName.c_str(), pkg.c_str());
            } else {
                LOGW("preAppSpecialize: app_data_dir null and nice_name=\"%s\" does not "
                     "end with \"_zygote\" -> cannot resolve package", niceName.c_str());
            }
        }

        if (pkg.empty()) {
            LOGW("preAppSpecialize: could not resolve any package name for this "
                 "app_zygote spawn -> letting it through");
            api->setOption(zygisk::Option::DLCLOSE_MODULE_LIBRARY);
            return;
        }

        // Try reading the policy file directly first (cheap, no IPC). On this
        // device that fails with EACCES from the zygote domain, so fall back
        // to asking the root companion process, which runs in a domain that
        // can read /data/adb.
        bool fileError = false;
        bool denied = isPackageDenied(pkg, &fileError);
        if (fileError) {
            LOGD("preAppSpecialize: direct read failed -> falling back to companion");
            denied = isPackageDeniedViaCompanion(api, pkg);
        }

        if (denied) {
            // Always logged, both flavors: this is the one event the whole
            // module exists to produce, and it's rare enough (only fires for
            // packages you explicitly denied) not to spam release logcat.
            LOGI("preAppSpecialize: pkg=\"%s\" IS DENIED -- sending SIGKILL now, "
                 "before ZygotePreload.doPreload() can run", pkg.c_str());
            // Die *before* ZygotePreload.doPreload() can execute.
            // system_server sees the app_zygote as crashed -> isolated service
            // bind times out. DirtySepolicy will show:
            //   "WARNING: Service connection timedout, app zygote crashed?"
            // which is the EXPECTED result when blocking is working correctly.
            
            // Gunakan SIGKILL agar proses terbunuh secara abnormal 
            // sehingga ActivityManagerService langsung melakukan cleanup
            kill(getpid(), SIGKILL);
        }


        LOGD("preAppSpecialize: pkg=\"%s\" allowed (not on denylist) -> unloading", pkg.c_str());
        api->setOption(zygisk::Option::DLCLOSE_MODULE_LIBRARY);
    }

    void preServerSpecialize(ServerSpecializeArgs *args) override {
        LOGD("preServerSpecialize: system_server spawn, nothing to do -> unloading");
        api->setOption(zygisk::Option::DLCLOSE_MODULE_LIBRARY);
    }

private:
    Api *api = nullptr;
    JNIEnv *env = nullptr;
};

// Runs in the Zygisk provider's own root daemon process/domain (e.g.
// zygiskd), which -- unlike the "zygote" domain preAppSpecialize() runs in --
// has SELinux access to /data/adb. Reads [uint32 len][pkg bytes], writes
// back [uint8 0/1].
static void companion_handler(int fd) {
    uint32_t len = 0;
    if (read(fd, &len, sizeof(len)) != (ssize_t) sizeof(len) || len == 0 || len > 255) {
        LOGW("companion_handler: bad/oversized length (len=%u)", len);
        uint8_t no = 0;
        write(fd, &no, sizeof(no));
        return;
    }

    std::string pkg(len, '\0');
    if (read(fd, &pkg[0], len) != (ssize_t) len) {
        LOGW("companion_handler: failed reading %u byte package name", len);
        uint8_t no = 0;
        write(fd, &no, sizeof(no));
        return;
    }

    bool fileError = false;
    bool denied = isPackageDenied(pkg, &fileError);
    if (denied) {
        LOGI("companion_handler: pkg=\"%s\" verdict=DENIED (running as uid=%d, fileError=%s)",
             pkg.c_str(), getuid(), fileError ? "true" : "false");
    } else {
        LOGD("companion_handler: pkg=\"%s\" verdict=allowed (running as uid=%d, fileError=%s)",
             pkg.c_str(), getuid(), fileError ? "true" : "false");
    }

    uint8_t result = denied ? 1 : 0;
    write(fd, &result, sizeof(result));
}

REGISTER_ZYGISK_MODULE(IsolationPolicyModule)
REGISTER_ZYGISK_COMPANION(companion_handler)
