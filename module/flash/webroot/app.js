const BUILD = window.ISOLATION_POLICY_BUILD || {
    moduleId: "zygisk_isolationpolicy",
    buildType: "unknown",
    version: "unknown",
    versionCode: 0,
    builtAt: null,
};

const MODULE_DIR = `/data/adb/modules/${BUILD.moduleId}`;
const POLICY_DIR = "/data/adb/isolationpolicy";
const POLICY_FILE = `${POLICY_DIR}/denied.list`;
const PKG_RE = /^[a-zA-Z][a-zA-Z0-9_.]*$/;
const KNOWN_ABIS = ["arm64-v8a", "armeabi-v7a", "x86_64", "x86"];
const DEFAULT_EXPORT_PATH = "/sdcard/Download/isolationpolicy_denylist.list";

const PREF_KEYS = {
    scope: "isolpolicy_scope",
    sort: "isolpolicy_sort",
    compact: "isolpolicy_compact",
    confirm: "isolpolicy_confirm_apply",
    haptics: "isolpolicy_haptics",
};

function getPref(key, fallback) {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v;
}
function getBoolPref(key, fallback) {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
}
function setPref(key, value) { localStorage.setItem(key, value); }
function setBoolPref(key, value) { localStorage.setItem(key, value ? "1" : "0"); }

const state = {
    packages: [],        // string[] - currently listed, depends on scope
    savedDenied: new Set(),   // what's actually on disk right now
    workingDenied: new Set(), // what the user has toggled (pre-Apply)
    filter: "",
    chip: "all",          // all | denied | allowed | pending
    scope: getPref(PREF_KEYS.scope, "user"),
    sort: getPref(PREF_KEYS.sort, "name"),
    status: null,         // parsed KEY=VALUE device/module status
    lastAppliedSnapshot: null, // Set snapshot for Undo
};

const settings = {
    compact: getBoolPref(PREF_KEYS.compact, false),
    confirmApply: getBoolPref(PREF_KEYS.confirm, false),
    haptics: getBoolPref(PREF_KEYS.haptics, true),
};

const els = {};

function $(id) { return document.getElementById(id); }

function haptic() {
    if (settings.haptics && navigator.vibrate) {
        try { navigator.vibrate(12); } catch (_) { /* ignore */ }
    }
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------------------
// Snackbar (MD3 transient feedback, with optional action button)
// ---------------------------------------------------------------------------
let snackbarTimer = null;
function showSnackbar(text, opts) {
    opts = opts || {};
    els.snackbarText.textContent = text;
    els.snackbar.classList.toggle("error", !!opts.error);

    if (opts.actionLabel && opts.onAction) {
        els.snackbarAction.textContent = opts.actionLabel;
        els.snackbarAction.hidden = false;
        els.snackbarAction.onclick = () => {
            clearTimeout(snackbarTimer);
            els.snackbar.classList.remove("show");
            opts.onAction();
        };
    } else {
        els.snackbarAction.hidden = true;
        els.snackbarAction.onclick = null;
    }

    els.snackbar.classList.remove("show");
    void els.snackbar.offsetWidth;
    els.snackbar.classList.add("show");
    clearTimeout(snackbarTimer);
    const duration = opts.duration || (opts.error ? 4500 : (opts.actionLabel ? 5000 : 2600));
    snackbarTimer = setTimeout(() => els.snackbar.classList.remove("show"), duration);
}

// ---------------------------------------------------------------------------
// Generic dialog engine (bottom sheet / centered dialog, scrim, back-button aware)
// ---------------------------------------------------------------------------
let openDialogId = null;
let historyDepth = 0;

function openDialog(id) {
    const dlg = $(id);
    if (!dlg) return;
    const wasOpen = !!openDialogId;
    if (openDialogId) closeDialog(openDialogId, { skipHistory: true });
    openDialogId = id;
    els.scrim.classList.add("show");
    dlg.classList.add("show");
    if (wasOpen) {
        // Switching from one dialog straight to another: same history depth,
        // just relabel the current entry so back still only needs one press.
        history.replaceState({ isolpolicyDialog: id }, "");
    } else {
        history.pushState({ isolpolicyDialog: id }, "");
        historyDepth++;
    }
}

function closeDialog(id, opts) {
    opts = opts || {};
    const dlg = $(id || openDialogId);
    if (dlg) dlg.classList.remove("show");
    if (!openDialogId) return;
    els.scrim.classList.remove("show");
    openDialogId = null;
    if (!opts.skipHistory && historyDepth > 0) {
        historyDepth--;
        history.back();
    }
}

window.addEventListener("popstate", () => {
    if (openDialogId) {
        historyDepth = Math.max(0, historyDepth - 1);
        closeDialog(openDialogId, { skipHistory: true });
    }
});

document.addEventListener("click", (e) => {
    if (e.target === els.scrim) closeDialog();
});

let confirmCallback = null;
function askConfirm(title, body, onConfirm) {
    $("confirmTitle").textContent = title;
    $("confirmBody").textContent = body;
    confirmCallback = onConfirm;
    openDialog("dlgConfirm");
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
function scopeFlag(scope) {
    if (scope === "system") return "-s";
    if (scope === "all") return "";
    return "-3"; // user
}

async function loadInstalledPackages() {
    const flag = scopeFlag(state.scope);
    const res = await exec(`pm list packages ${flag}`.trim());
    if (res.errno !== 0) {
        throw new Error(`pm list packages failed: ${res.stderr || res.errno}`);
    }
    return res.stdout
        .split("\n")
        .map((l) => l.replace(/^package:/, "").trim())
        .filter((p) => PKG_RE.test(p))
        .sort();
}

async function loadDeniedSet() {
    const res = await exec(`[ -f ${POLICY_FILE} ] && cat ${POLICY_FILE} || true`);
    const set = new Set();
    res.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"))
        .forEach((p) => set.add(p));
    return set;
}

async function writeDeniedSet(set) {
    const safe = [...set].filter((p) => PKG_RE.test(p));
    const lines = safe.map((p) => `echo ${p} >> ${POLICY_FILE}.tmp`).join(" && ");
    const script = [
        `mkdir -p ${POLICY_DIR}`,
        `: > ${POLICY_FILE}.tmp`,
        lines || "true",
        `mv ${POLICY_FILE}.tmp ${POLICY_FILE}`,
        `chmod 600 ${POLICY_FILE}`,
    ].join(" && ");
    const res = await exec(script);
    if (res.errno !== 0) {
        throw new Error(`failed to save denylist: ${res.stderr || res.errno}`);
    }
}

// One combined root exec call that gathers everything the status dialog and
// stat row need: root manager, Zygisk provider, module enabled/disabled,
// device SDK/ABI, denylist mtime, and per-ABI native lib presence. Kept as a
// single round trip on purpose (each exec() call is a bridge round trip).
async function collectDeviceStatus() {
    const script = [
        `ROOT_MGR="Unknown"`,
        `[ -d /data/adb/ksu ] && ROOT_MGR="KernelSU"`,
        `[ "$ROOT_MGR" = "Unknown" ] && [ -d /data/adb/ap ] && ROOT_MGR="APatch"`,
        `[ "$ROOT_MGR" = "Unknown" ] && { [ -d /data/adb/magisk ] || command -v magisk >/dev/null 2>&1; } && ROOT_MGR="Magisk"`,
        `ZYGISK_PROVIDER="Not detected"`,
        `[ -d /data/adb/modules/zygisksu ] && ZYGISK_PROVIDER="KernelSU Zygisk"`,
        `[ "$ZYGISK_PROVIDER" = "Not detected" ] && [ -e /data/adb/zygisk_enabled ] && ZYGISK_PROVIDER="Magisk Zygisk"`,
        `echo "ROOT_MGR=$ROOT_MGR"`,
        `echo "ZYGISK_PROVIDER=$ZYGISK_PROVIDER"`,
        `echo "MODULE_ENABLED=$([ -f ${MODULE_DIR}/disable ] && echo 0 || echo 1)"`,
        `echo "SDK=$(getprop ro.build.version.sdk)"`,
        `echo "ANDROID_VER=$(getprop ro.build.version.release)"`,
        `echo "ABI=$(getprop ro.product.cpu.abi)"`,
        `echo "DENIED_MTIME=$(stat -c %Y ${POLICY_FILE} 2>/dev/null || echo 0)"`,
        `for a in ${KNOWN_ABIS.join(" ")}; do echo "LIB_$a=$([ -f ${MODULE_DIR}/zygisk/$a.so ] && echo 1 || echo 0)"; done`,
    ].join("\n");

    const res = await exec(script);
    const info = {};
    (res.stdout || "").split("\n").forEach((line) => {
        const idx = line.indexOf("=");
        if (idx > 0) info[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    });
    return info;
}

// ---------------------------------------------------------------------------
// Real app icons (lazy-loaded)
// ---------------------------------------------------------------------------
// Preferred path: recent KernelSU / KernelSU Next / APatch webviews expose a
// custom "ksu://icon/<package>" URI scheme that resolves directly to the
// app's launcher icon bytes - the webview's own scheme handler does the
// fetch, no shell round trip needed. This is the same approach Tricky Addon
// uses. `ksu.getPackagesInfo` existing is used as the version marker for
// "this bridge is new enough to support the icon scheme".
//
// Fallback path (older/plain KernelSU webview bridges that only expose
// ksu.exec): pull the icon out of the APK ourselves via aapt/aapt2 if it
// happens to be on PATH. Not every device ships aapt, so this quietly gives
// up and leaves the monogram-letter avatar in place when it's missing -
// never breaks either way.
const ICON_CACHE = new Map(); // pkg -> data URI string | null (tried & failed, aapt path only)
let aaptBinPromise = null;

function hasKsuIconScheme() {
    return hasPackagesInfoBridge();
}

function findAapt() {
    if (!aaptBinPromise) {
        const candidates = ["aapt2", "aapt", "/system/bin/aapt2", "/system/bin/aapt"];
        const probe = candidates.map((b) => `command -v '${b}' >/dev/null 2>&1 && echo '${b}' && exit 0`).join("; ");
        aaptBinPromise = exec(`${probe}; true`)
            .then((res) => res.stdout.trim().split("\n")[0] || null)
            .catch(() => null);
    }
    return aaptBinPromise;
}

async function fetchAppIconViaAapt(pkg) {
    try {
        const aapt = await findAapt();
        if (!aapt) return null;

        const pathRes = await exec(`pm path ${pkg} 2>/dev/null | head -n1 | sed 's/^package://'`);
        const apk = pathRes.stdout.trim();
        if (!apk || pathRes.errno !== 0) return null;

        // Highest-density application-icon-NNN line wins; adaptive/XML icons
        // (no raster PNG) are skipped since they can't be shown as an <img>.
        const iconRes = await exec(
            `${aapt} dump badging '${apk}' 2>/dev/null | grep "^application-icon-" | ` +
            `sort -t- -k3 -n | tail -n1 | sed -E "s/^application-icon-[0-9]+:'([^']+)'.*/\\1/"`
        );
        const iconPath = iconRes.stdout.trim();
        if (!iconPath || !/\.(png|webp)$/i.test(iconPath)) return null;

        const b64Res = await exec(`unzip -p '${apk}' '${iconPath}' 2>/dev/null | base64 -w0`);
        const b64 = b64Res.stdout.trim();
        if (!b64) return null;

        const mime = /\.webp$/i.test(iconPath) ? "image/webp" : "image/png";
        return `data:${mime};base64,${b64}`;
    } catch (_) {
        return null;
    }
}

// App label (display name) is not exposed by `pm list packages`, and dumpsys
// only stores the resource id, not the resolved string - so the only source
// we have (short of the ksu bridge exposing it, which it doesn't today) is
// the same aapt path already used for icons above. Kept as its own tiny exec
// round trip (not merged into fetchAppIconViaAapt) so a device without aapt,
// or one using the fast ksu://icon/ scheme for icons, still falls back
// cleanly to just showing the package name twice - never breaks either way.
const LABEL_CACHE = new Map(); // pkg -> label string | null (couldn't resolve)

// Preferred path: one synchronous ksu.getPackagesInfo() batch call for every
// installed package at once, right after the package list loads. This is
// what Tricky Addon uses (via the kernelsu-alt bridge library) - the raw
// bridge call `ksu.getPackagesInfo(JSON.stringify(pkgs))` returns appLabel
// directly, no aapt/exec round trip per app needed. Populates LABEL_CACHE in
// bulk so render() below picks the real names up immediately instead of
// falling through to the per-row lazy aapt fallback.
// Returns true if the batch call was usable (bridge present, non-empty
// result), so callers know whether the aapt fallback is still needed.
function fetchAppLabelsBatch(pkgs) {
    if (!hasPackagesInfoBridge() || pkgs.length === 0) return false;
    const infos = getPackagesInfo(pkgs);
    if (infos.length === 0) return false;
    for (const info of infos) {
        if (info && info.packageName) {
            LABEL_CACHE.set(info.packageName, info.appLabel || null);
        }
    }
    return true;
}

async function fetchAppLabelViaAapt(pkg) {
    try {
        const aapt = await findAapt();
        if (!aapt) return null;

        const pathRes = await exec(`pm path ${pkg} 2>/dev/null | head -n1 | sed 's/^package://'`);
        const apk = pathRes.stdout.trim();
        if (!apk || pathRes.errno !== 0) return null;

        const labelRes = await exec(
            `${aapt} dump badging '${apk}' 2>/dev/null | grep -m1 "^application-label:" | ` +
            `sed -E "s/^application-label:'(.*)'$/\\1/"`
        );
        const label = labelRes.stdout.trim();
        return label || null;
    } catch (_) {
        return null;
    }
}

function applyLabelToRow(row, label) {
    if (!label || !row.isConnected) return; // couldn't resolve, or row got re-rendered away already
    const nameEl = row.querySelector(".app-name");
    if (nameEl) nameEl.textContent = label;
}

function loadLabelForRow(row) {
    const pkg = row.dataset.pkg;
    if (!pkg || !row.isConnected) return;

    if (LABEL_CACHE.has(pkg)) {
        applyLabelToRow(row, LABEL_CACHE.get(pkg));
        return;
    }
    fetchAppLabelViaAapt(pkg).then((label) => {
        LABEL_CACHE.set(pkg, label);
        applyLabelToRow(row, label);
    });
}

// Same lazy-on-scroll approach as iconObserver, kept separate since a row
// can have its icon cached already while its label still isn't (or vice
// versa) - each cache fills independently.
const labelObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target;
        labelObserver.unobserve(el);
        loadLabelForRow(el);
    }
}, { rootMargin: "200px 0px" });

function applyIconToAvatar(el, uri) {
    if (!uri || !el.isConnected) return; // no icon found, or row was re-rendered away already
    el.textContent = "";
    const img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    img.src = uri;
    el.appendChild(img);
    el.classList.add("has-icon");
}

function loadIconForRow(el) {
    const pkg = el.dataset.pkg;
    if (!pkg || !el.isConnected) return;

    if (hasKsuIconScheme()) {
        // Direct scheme URI - the webview fetches the bytes itself, so this
        // is cheap and doesn't need our own caching or exec round trip.
        const img = document.createElement("img");
        img.alt = "";
        img.loading = "lazy";
        img.onload = () => { if (el.isConnected) el.classList.add("has-icon"); };
        img.onerror = () => img.remove(); // leave the monogram avatar in place
        img.src = `ksu://icon/${pkg}`;
        el.textContent = "";
        el.appendChild(img);
        return;
    }

    if (ICON_CACHE.has(pkg)) {
        applyIconToAvatar(el, ICON_CACHE.get(pkg));
        return;
    }
    fetchAppIconViaAapt(pkg).then((uri) => {
        ICON_CACHE.set(pkg, uri);
        applyIconToAvatar(el, uri);
    });
}

// Shared observer: only fetches an icon once its row actually scrolls into
// view, so opening the list for a device with hundreds of apps doesn't fire
// hundreds of icon loads up front.
const iconObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target;
        iconObserver.unobserve(el);
        loadIconForRow(el);
    }
}, { rootMargin: "200px 0px" });

async function loadLogs() {
    els.logOutput.textContent = i18n.t("loading_generic");
    try {
        const res = await exec(`logcat -d -t 500 IsolPolicyZygisk:V *:S 2>&1`);
        const text = (res.stdout || "").trim();
        els.logOutput.textContent = text
            ? text
            : "No matching log lines in the buffer yet.\n\nTip: this module's release build intentionally logs very little " +
              "(only denylist hits + real errors). For full per-event tracing, flash the debug build zip instead - " +
              "both can be installed side by side since they use different module IDs.";
    } catch (err) {
        els.logOutput.textContent = `Failed to read logs: ${err.message || err}`;
    }
}

async function toggleModule() {
    const currentlyEnabled = state.status ? state.status.MODULE_ENABLED === "1" : true;
    const action = currentlyEnabled ? "disabled" : "enabled";
    els.toggleModuleBtn.disabled = true;
    try {
        const script = currentlyEnabled ? `touch ${MODULE_DIR}/disable` : `rm -f ${MODULE_DIR}/disable`;
        const res = await exec(script);
        if (res.errno !== 0) throw new Error(res.stderr || `exit code ${res.errno}`);
        showSnackbar(i18n.t("toast_module_toggled", { state: i18n.t(`toast_${action}`) }));
        state.status = await collectDeviceStatus();
        renderStatusDialog();
    } catch (err) {
        showSnackbar(i18n.t("toast_error_generic", { msg: String(err.message || err) }), { error: true });
    } finally {
        els.toggleModuleBtn.disabled = false;
    }
}

// Fetch extra detail for a single package, on demand (app detail dialog).
async function loadAppDetail(pkg) {
    const script = [
        `D="$(dumpsys package ${pkg} 2>/dev/null)"`,
        `echo "VNAME=$(echo "$D" | grep -m1 -o 'versionName=[^ ]*' | cut -d= -f2)"`,
        `echo "VCODE=$(echo "$D" | grep -m1 -o 'versionCode=[0-9]*' | cut -d= -f2)"`,
        `echo "MINSDK=$(echo "$D" | grep -m1 -o 'minSdk=[0-9]*' | cut -d= -f2)"`,
        `echo "TARGETSDK=$(echo "$D" | grep -m1 -o 'targetSdk=[0-9]*' | cut -d= -f2)"`,
        `echo "FIRSTINSTALL=$(echo "$D" | grep -m1 'firstInstallTime=' | sed 's/.*firstInstallTime=//')"`,
        `echo "LASTUPDATE=$(echo "$D" | grep -m1 'lastUpdateTime=' | sed 's/.*lastUpdateTime=//')"`,
        `echo "CODEPATH=$(echo "$D" | grep -m1 -o 'codePath=[^ ]*' | cut -d= -f2)"`,
        `echo "UID=$(echo "$D" | grep -m1 -o 'userId=[0-9]*' | cut -d= -f2)"`,
    ].join("\n");
    const res = await exec(script);
    const info = {};
    (res.stdout || "").split("\n").forEach((line) => {
        const idx = line.indexOf("=");
        if (idx > 0) info[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    });
    return info;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderBuildChip() {
    if (BUILD.buildType === "debug") {
        els.buildChip.textContent = "Debug build";
        els.buildChip.className = "badge-chip warn";
    } else if (BUILD.buildType === "release") {
        els.buildChip.textContent = "Release build";
        els.buildChip.className = "badge-chip ok";
    } else {
        els.buildChip.textContent = "Build: unknown";
        els.buildChip.className = "badge-chip";
    }
}

function fmtTimestamp(epochSeconds) {
    const n = Number(epochSeconds);
    if (!n) return "Never";
    const d = new Date(n * 1000);
    return d.toLocaleDateString(undefined, { day: "2-digit", month: "short" }) +
        " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function pendingCount() {
    let n = 0;
    for (const p of state.workingDenied) if (!state.savedDenied.has(p)) n++;
    for (const p of state.savedDenied) if (!state.workingDenied.has(p)) n++;
    return n;
}

function updateStats() {
    els.statInstalled.textContent = state.packages.length;
    els.statDenied.textContent = state.workingDenied.size;
    els.statUpdated.textContent = state.status ? fmtTimestamp(state.status.DENIED_MTIME) : "–";

    const n = pendingCount();
    els.fabApply.setAttribute("data-empty", n === 0 ? "true" : "false");
    if (n > 0) {
        els.fabCount.hidden = false;
        els.fabCount.textContent = n;
    } else {
        els.fabCount.hidden = true;
    }
}

function infoRow(label, value, cls) {
    const row = document.createElement("div");
    row.className = "info-row";
    const l = document.createElement("span");
    l.className = "info-label";
    l.textContent = label;
    const v = document.createElement("span");
    v.className = "info-value" + (cls ? ` ${cls}` : "");
    v.textContent = value;
    row.appendChild(l);
    row.appendChild(v);
    return row;
}

function renderStatusDialog() {
    const grid = els.infoGrid;
    grid.innerHTML = "";

    grid.appendChild(infoRow("Version", BUILD.version || "unknown"));
    grid.appendChild(infoRow("Module ID", BUILD.moduleId || "unknown"));
    if (BUILD.builtAt) {
        grid.appendChild(infoRow("Built", new Date(BUILD.builtAt).toLocaleString()));
    }

    const s = state.status;
    if (!s) {
        grid.appendChild(infoRow("Root/device status", "unavailable (no root bridge)"));
        els.toggleModuleBtn.hidden = true;
        return;
    }

    els.toggleModuleBtn.hidden = false;
    const enabled = s.MODULE_ENABLED === "1";

    grid.appendChild(infoRow("Root manager", s.ROOT_MGR || "Unknown"));
    grid.appendChild(infoRow("Zygisk provider", s.ZYGISK_PROVIDER || "Not detected",
        (s.ZYGISK_PROVIDER === "Not detected") ? "warn" : "ok"));
    grid.appendChild(infoRow("Module state", enabled ? "Enabled" : "Disabled", enabled ? "ok" : "warn"));
    grid.appendChild(infoRow("Android version", `${s.ANDROID_VER || "?"} (SDK ${s.SDK || "?"})`));
    grid.appendChild(infoRow("Device ABI", s.ABI || "unknown"));

    const deviceAbi = s.ABI;
    const libStatus = KNOWN_ABIS
        .map((abi) => {
            const present = s[`LIB_${abi}`] === "1";
            const mark = present ? "✓" : "✗";
            return abi === deviceAbi ? `${mark} ${abi} (device)` : `${mark} ${abi}`;
        })
        .join("  ·  ");
    const deviceLibPresent = s[`LIB_${deviceAbi}`] === "1";
    grid.appendChild(infoRow("Native libs", libStatus, deviceLibPresent ? "ok" : "warn"));
    grid.appendChild(infoRow("Denylist file", POLICY_FILE));
    grid.appendChild(infoRow("App scope", state.scope));

    els.toggleModuleBtn.textContent = enabled ? "Disable module" : "Enable module";
    els.toggleModuleBtn.className = "btn btn-outlined" + (enabled ? " btn-danger" : "");
}

function shortLabel(pkg) {
    const seg = pkg.split(".").filter(Boolean).pop() || pkg;
    return seg.slice(0, 2);
}

function sortPackages(list) {
    const arr = [...list];
    if (state.sort === "denied") {
        arr.sort((a, b) => {
            const da = state.workingDenied.has(a) ? 0 : 1;
            const db = state.workingDenied.has(b) ? 0 : 1;
            return da - db || a.localeCompare(b);
        });
    } else if (state.sort === "pending") {
        const isPending = (p) => state.workingDenied.has(p) !== state.savedDenied.has(p);
        arr.sort((a, b) => {
            const pa = isPending(a) ? 0 : 1;
            const pb = isPending(b) ? 0 : 1;
            return pa - pb || a.localeCompare(b);
        });
    } else {
        arr.sort((a, b) => a.localeCompare(b));
    }
    return arr;
}

function visiblePackages() {
    const q = state.filter.trim().toLowerCase();
    return sortPackages(state.packages).filter((pkg) => {
        if (q && !pkg.toLowerCase().includes(q)) return false;
        const denied = state.workingDenied.has(pkg);
        const pending = denied !== state.savedDenied.has(pkg);
        if (state.chip === "denied" && !denied) return false;
        if (state.chip === "allowed" && denied) return false;
        if (state.chip === "pending" && !pending) return false;
        return true;
    });
}

function render() {
    const list = visiblePackages();
    const frag = document.createDocumentFragment();
    iconObserver.disconnect(); // rows get rebuilt below - drop watches on the old ones
    labelObserver.disconnect();

    for (const pkg of list) {
        const isDenied = state.workingDenied.has(pkg);
        const isPending = isDenied !== state.savedDenied.has(pkg);

        const row = document.createElement("div");
        row.className = "row";
        row.dataset.denied = String(isDenied);
        row.dataset.pending = String(isPending);
        row.dataset.pkg = pkg;

        const avatar = document.createElement("span");
        avatar.className = "row-avatar";
        avatar.textContent = shortLabel(pkg);
        avatar.dataset.pkg = pkg;
        if (ICON_CACHE.has(pkg)) {
            applyIconToAvatar(avatar, ICON_CACHE.get(pkg));
        } else {
            iconObserver.observe(avatar);
        }

        const textWrap = document.createElement("div");
        textWrap.className = "row-text";

        const nameEl = document.createElement("span");
        nameEl.className = "app-name";
        nameEl.textContent = pkg; // placeholder until the real label resolves (or stays, if it can't)
        textWrap.appendChild(nameEl);

        const pkgEl = document.createElement("span");
        pkgEl.className = "pkg";
        pkgEl.textContent = pkg;
        textWrap.appendChild(pkgEl);

        if (LABEL_CACHE.has(pkg)) {
            const cachedLabel = LABEL_CACHE.get(pkg);
            if (cachedLabel) nameEl.textContent = cachedLabel;
        } else {
            labelObserver.observe(row); // row.querySelector(".app-name") in the callback needs textWrap appended first (done below), which has already happened by the time this fires async
        }

        const infoBtn = document.createElement("button");
        infoBtn.type = "button";
        infoBtn.className = "icon-btn icon-btn-sm row-info-btn";
        infoBtn.setAttribute("aria-label", "App details");
        infoBtn.innerHTML = '<span class="msi">info</span>';
        infoBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            openAppDetail(pkg);
        });

        const sw = document.createElement("md-switch");
        sw.icons = true;
        sw.selected = isDenied;
        sw.setAttribute("aria-label", `Deny isolated services for ${pkg}`);
        sw.addEventListener("change", () => {
            if (sw.selected) state.workingDenied.add(pkg);
            else state.workingDenied.delete(pkg);
            const nowPending = sw.selected !== state.savedDenied.has(pkg);
            row.dataset.denied = String(sw.selected);
            row.dataset.pending = String(nowPending);
            haptic();
            updateStats();
            if (state.chip !== "all") render(); // row may need to (dis)appear under the active chip
        });

        row.addEventListener("click", (e) => {
            if (e.target.closest("md-switch") || e.target.closest(".row-info-btn")) return;
            sw.selected = !sw.selected;
            sw.dispatchEvent(new Event("change"));
        });

        row.appendChild(avatar);
        row.appendChild(textWrap);
        row.appendChild(infoBtn);
        row.appendChild(sw);
        frag.appendChild(row);
    }

    els.list.innerHTML = "";
    els.list.appendChild(frag);
    els.empty.style.display = list.length === 0 ? "block" : "none";
    updateStats();
}

// ---------------------------------------------------------------------------
// App detail dialog
// ---------------------------------------------------------------------------
async function openAppDetail(pkg) {
    $("appDetailTitle").textContent = pkg;
    $("appDetailBody").innerHTML = `<div class="spinner-row"><span class="loader-spin"></span><span>${i18n.t("loading_generic")}</span></div>`;
    openDialog("dlgAppDetail");
    try {
        const d = await loadAppDetail(pkg);
        const grid = document.createElement("div");
        grid.className = "info-grid";
        const rows = [
            ["Version", d.VNAME && d.VCODE ? `${d.VNAME} (${d.VCODE})` : (d.VNAME || d.VCODE || "unknown")],
            ["Min / Target SDK", `${d.MINSDK || "?"} / ${d.TARGETSDK || "?"}`],
            ["First installed", d.FIRSTINSTALL || "unknown"],
            ["Last updated", d.LASTUPDATE || "unknown"],
            ["App UID", d.UID || "unknown"],
            ["Install path", d.CODEPATH || "unknown"],
            ["Denylist status", state.workingDenied.has(pkg) ? "Denied" : "Allowed", state.workingDenied.has(pkg) ? "warn" : "ok"],
        ];
        grid.innerHTML = "";
        rows.forEach(([label, value, cls]) => grid.appendChild(infoRow(label, value, cls)));
        $("appDetailBody").innerHTML = "";
        $("appDetailBody").appendChild(grid);
    } catch (err) {
        $("appDetailBody").textContent = `Failed to load details: ${err.message || err}`;
    }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function refresh() {
    showSnackbar(i18n.t("toast_loading_apps"));
    try {
        const [packages, saved, status] = await Promise.all([
            loadInstalledPackages(),
            loadDeniedSet(),
            collectDeviceStatus(),
        ]);
        state.packages = packages;
        state.savedDenied = saved;
        state.workingDenied = new Set(saved);
        state.status = status;
        fetchAppLabelsBatch(packages); // sync bridge call - fills LABEL_CACHE before render() reads it
        render();
        renderStatusDialog();
        showSnackbar(i18n.t("toast_loaded_apps", { n: packages.length }));
    } catch (err) {
        showSnackbar(i18n.t("toast_error_generic", { msg: String(err.message || err) }), { error: true });
    }
}

async function doApply() {
    showSnackbar(i18n.t("toast_saving"));
    els.fabApply.disabled = true;
    try {
        state.lastAppliedSnapshot = new Set(state.savedDenied);
        await writeDeniedSet(state.workingDenied);
        state.savedDenied = new Set(state.workingDenied);
        state.status = await collectDeviceStatus();
        render();
        renderStatusDialog();
        showSnackbar(i18n.t("toast_saved", { n: state.savedDenied.size }), {
            actionLabel: i18n.t("toast_undo"),
            onAction: undoLastApply,
        });
    } catch (err) {
        showSnackbar(i18n.t("toast_error_generic", { msg: String(err.message || err) }), { error: true });
    } finally {
        els.fabApply.disabled = false;
    }
}

async function undoLastApply() {
    if (!state.lastAppliedSnapshot) return;
    try {
        await writeDeniedSet(state.lastAppliedSnapshot);
        state.savedDenied = new Set(state.lastAppliedSnapshot);
        state.workingDenied = new Set(state.lastAppliedSnapshot);
        state.lastAppliedSnapshot = null;
        state.status = await collectDeviceStatus();
        render();
        renderStatusDialog();
        showSnackbar(i18n.t("toast_reverted"));
    } catch (err) {
        showSnackbar(i18n.t("toast_error_generic", { msg: String(err.message || err) }), { error: true });
    }
}

function requestApply() {
    const n = pendingCount();
    if (n === 0) return;
    if (settings.confirmApply) {
        askConfirm(i18n.t("fab_apply"), i18n.t("toast_confirm_apply", { n }), doApply);
    } else {
        doApply();
    }
}

function bulkSetVisible(denied) {
    for (const pkg of visiblePackages()) {
        if (denied) state.workingDenied.add(pkg);
        else state.workingDenied.delete(pkg);
    }
    render();
}

function invertVisible() {
    for (const pkg of visiblePackages()) {
        if (state.workingDenied.has(pkg)) state.workingDenied.delete(pkg);
        else state.workingDenied.add(pkg);
    }
    render();
}

// ---------------------------------------------------------------------------
// App scope / sort dialogs
// ---------------------------------------------------------------------------
function markSelected(container, attr, value) {
    container.querySelectorAll("[data-selected]").forEach((el) => el.removeAttribute("data-selected"));
    const target = container.querySelector(`[${attr}="${value}"]`);
    if (target) target.setAttribute("data-selected", "true");
}

function refreshScopeDialogSelection() { markSelected($("dlgScope"), "data-scope", state.scope); }
function refreshSortDialogSelection() { markSelected($("dlgSort"), "data-sort", state.sort); }
function refreshLangDialogSelection() { markSelected($("dlgSettings"), "data-lang", i18n.lang); }

async function setScope(scope) {
    if (scope === state.scope) { closeDialog(); return; }
    state.scope = scope;
    setPref(PREF_KEYS.scope, scope);
    closeDialog();
    await refresh();
}

function setSort(sort) {
    state.sort = sort;
    setPref(PREF_KEYS.sort, sort);
    refreshSortDialogSelection();
    closeDialog();
    render();
}

// ---------------------------------------------------------------------------
// Backup & restore
// ---------------------------------------------------------------------------
async function exportDenylist() {
    const path = els.exportPath.value.trim() || DEFAULT_EXPORT_PATH;
    try {
        const lines = [...state.savedDenied].sort();
        const script = [
            `mkdir -p "$(dirname '${path}')"`,
            `: > '${path}'`,
            lines.map((p) => `echo ${p} >> '${path}'`).join(" && ") || "true",
        ].join(" && ");
        const res = await exec(script);
        if (res.errno !== 0) throw new Error(res.stderr || `exit code ${res.errno}`);
        showSnackbar(i18n.t("toast_export_ok", { n: lines.length, path }));
    } catch (err) {
        showSnackbar(i18n.t("toast_error_generic", { msg: String(err.message || err) }), { error: true });
    }
}

async function importDenylist() {
    const path = els.importPath.value.trim();
    if (!path) return;
    try {
        const res = await exec(`cat '${path}' 2>/dev/null || true`);
        if (res.errno !== 0) throw new Error(res.stderr || `exit code ${res.errno}`);
        const imported = res.stdout
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith("#") && PKG_RE.test(l));

        if (els.importReplace.selected) {
            state.workingDenied = new Set(imported);
        } else {
            imported.forEach((p) => state.workingDenied.add(p));
        }
        render();
        closeDialog();
        showSnackbar(i18n.t("toast_import_ok", { n: imported.length, path }));
    } catch (err) {
        showSnackbar(i18n.t("toast_error_generic", { msg: String(err.message || err) }), { error: true });
    }
}

async function copyDenylistToClipboard() {
    const text = [...state.workingDenied].sort().join("\n");
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
        } else {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            document.body.removeChild(ta);
        }
        showSnackbar(i18n.t("toast_copied"));
    } catch (err) {
        showSnackbar(i18n.t("toast_copy_failed"), { error: true });
    }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function applyDensity() {
    document.body.setAttribute("data-density", settings.compact ? "compact" : "comfortable");
}

function initSettingsDialog() {
    els.setCompact.selected = settings.compact;
    els.setConfirm.selected = settings.confirmApply;
    els.setHaptics.selected = settings.haptics;

    els.setCompact.addEventListener("change", () => {
        settings.compact = els.setCompact.selected;
        setBoolPref(PREF_KEYS.compact, settings.compact);
        applyDensity();
    });
    els.setConfirm.addEventListener("change", () => {
        settings.confirmApply = els.setConfirm.selected;
        setBoolPref(PREF_KEYS.confirm, settings.confirmApply);
    });
    els.setHaptics.addEventListener("change", () => {
        settings.haptics = els.setHaptics.selected;
        setBoolPref(PREF_KEYS.haptics, settings.haptics);
    });

    $("dlgSettings").querySelectorAll("[data-lang]").forEach((el) => {
        el.addEventListener("click", () => {
            i18n.setLang(el.getAttribute("data-lang"));
            refreshLangDialogSelection();
            showSnackbar(i18n.t("app_title"));
        });
    });
}

// ---------------------------------------------------------------------------
// Menu wiring
// ---------------------------------------------------------------------------
function wireMenu() {
    $("miSelectAll").addEventListener("click", () => { bulkSetVisible(true); closeDialog(); });
    $("miDeselectAll").addEventListener("click", () => { bulkSetVisible(false); closeDialog(); });
    $("miInvert").addEventListener("click", () => { invertVisible(); closeDialog(); });
    $("miRefresh").addEventListener("click", () => { closeDialog(); refresh(); });
    $("miScope").addEventListener("click", () => { refreshScopeDialogSelection(); openDialog("dlgScope"); });
    $("miSort").addEventListener("click", () => { refreshSortDialogSelection(); openDialog("dlgSort"); });
    $("miBackup").addEventListener("click", () => {
        els.exportPath.value = DEFAULT_EXPORT_PATH;
        els.importPath.value = "";
        openDialog("dlgBackup");
    });
    $("miSettings").addEventListener("click", () => { refreshLangDialogSelection(); openDialog("dlgSettings"); });
    $("miStatus").addEventListener("click", () => { renderStatusDialog(); openDialog("dlgStatus"); });
    $("miHelp").addEventListener("click", () => {
        $("helpBody").innerHTML = i18n.t("help_html");
        openDialog("dlgHelp");
    });
    $("miAbout").addEventListener("click", () => {
        $("aboutVersion").textContent = `v${BUILD.version || "?"}`;
        openDialog("dlgAbout");
    });

    $("dlgScope").querySelectorAll("[data-scope]").forEach((el) => {
        el.addEventListener("click", () => setScope(el.getAttribute("data-scope")));
    });
    $("dlgSort").querySelectorAll("[data-sort]").forEach((el) => {
        el.addEventListener("click", () => setSort(el.getAttribute("data-sort")));
    });
}

// ---------------------------------------------------------------------------
// Top bar scroll elevation + search overlay
// ---------------------------------------------------------------------------
function wireTopbar() {
    window.addEventListener("scroll", () => {
        els.topbar.classList.toggle("scrolled", window.scrollY > 4);
    }, { passive: true });

    els.searchToggle.addEventListener("click", () => {
    const show = !els.searchOverlay.classList.contains("show");
    els.searchOverlay.classList.toggle("show", show);
    els.topbar.classList.toggle("search-active", show);
    els.searchToggle.setAttribute("data-active", String(show));
    if (show) {
        els.search.focus();
    } else {
        els.search.value = "";
        state.filter = "";
        render();
    }
});

els.searchClear.addEventListener("click", () => {
    els.search.value = "";
    state.filter = "";
    render();

    els.searchOverlay.classList.remove("show");
    els.topbar.classList.remove("search-active");
    els.searchToggle.setAttribute("data-active", "false");
});

    els.search.addEventListener("input", () => {
        state.filter = els.search.value;
        render();
    });

    els.chipRow.querySelectorAll(".chip").forEach((chip) => {
        chip.addEventListener("click", () => {
            els.chipRow.querySelectorAll(".chip").forEach((c) => c.setAttribute("data-selected", "false"));
            chip.setAttribute("data-selected", "true");
            state.chip = chip.getAttribute("data-filter");
            render();
        });
    });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
function init() {
    els.topbar = $("topbar");
    els.searchToggle = $("searchToggle");
    els.searchOverlay = $("searchOverlay");
    els.search = $("search");
    els.searchClear = $("searchClear");
    els.chipRow = $("chipRow");

    els.list = $("list");
    els.empty = $("empty");
    els.fabApply = $("apply");
    els.fabCount = $("fabCount");
    els.snackbar = $("snackbar");
    els.snackbarText = $("snackbarText");
    els.snackbarAction = $("snackbarAction");
    els.scrim = $("scrim");

    els.statInstalled = $("statInstalled");
    els.statDenied = $("statDenied");
    els.statUpdated = $("statUpdated");

    els.buildChip = $("buildChip");
    els.infoGrid = $("infoGrid");
    els.toggleModuleBtn = $("toggleModuleBtn");
    els.viewLogsBtn = $("viewLogsBtn");
    els.logOutput = $("logOutput");
    els.refreshLogsBtn = $("refreshLogsBtn");

    els.exportPath = $("exportPath");
    els.importPath = $("importPath");
    els.importReplace = $("importReplace");

    els.setCompact = $("setCompact");
    els.setConfirm = $("setConfirm");
    els.setHaptics = $("setHaptics");

    i18n.apply(document);
    applyDensity();
    renderBuildChip();
    renderStatusDialog();
    initSettingsDialog();
    wireMenu();
    wireTopbar();

    $("menuBtn").addEventListener("click", () => openDialog("dlgMenu"));
    $("viewLogsBtn").addEventListener("click", () => { openDialog("dlgLogs"); loadLogs(); });
    $("refreshLogsBtn").addEventListener("click", loadLogs);
    $("toggleModuleBtn").addEventListener("click", toggleModule);
    $("exportBtn").addEventListener("click", exportDenylist);
    $("importBtn").addEventListener("click", importDenylist);
    $("copyClipboardBtn").addEventListener("click", copyDenylistToClipboard);
    $("confirmCancelBtn").addEventListener("click", () => { confirmCallback = null; closeDialog(); });
    $("confirmOkBtn").addEventListener("click", () => {
        const cb = confirmCallback;
        confirmCallback = null;
        closeDialog();
        if (cb) cb();
    });

    document.querySelectorAll(".dialog-menu-btn").forEach((b) => {
        b.addEventListener("click", () => openDialog("dlgMenu"));
    });

    // Every .dialog gets a lightweight default close affordance: tapping the
    // grabber closes it (mirrors the platform's swipe-to-dismiss gesture).
    document.querySelectorAll(".dialog-grabber").forEach((g) => {
        g.addEventListener("click", () => closeDialog());
    });

    els.fabApply.addEventListener("click", requestApply);

    window.addEventListener("beforeunload", (e) => {
        if (pendingCount() > 0) { e.preventDefault(); e.returnValue = ""; }
    });

    if (!hasRootBridge()) {
        els.empty.textContent = i18n.t("empty_no_bridge");
        els.empty.style.display = "block";
        showSnackbar(i18n.t("toast_no_bridge"), { error: true });
        return;
    }

    refresh();
}

document.addEventListener("DOMContentLoaded", init);
