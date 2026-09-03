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

const state = {
    packages: [],   // string[]
    denied: new Set(),
    filter: "",
    status: null,   // parsed KEY=VALUE device/module status, see collectDeviceStatus()
};

const els = {};

function $(id) { return document.getElementById(id); }

// ---------------------------------------------------------------------------
// Snackbar (MD3 transient feedback)
// ---------------------------------------------------------------------------
let snackbarTimer = null;
function showSnackbar(text, isError) {
    els.snackbar.textContent = text;
    els.snackbar.classList.toggle("error", !!isError);
    // Force reflow so re-triggering the animation works on consecutive calls.
    els.snackbar.classList.remove("show");
    void els.snackbar.offsetWidth;
    els.snackbar.classList.add("show");
    clearTimeout(snackbarTimer);
    snackbarTimer = setTimeout(() => els.snackbar.classList.remove("show"), isError ? 4500 : 2600);
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
async function loadInstalledPackages() {
    // "-3" = third-party (user-installed) apps only. These are the only
    // apps the native module's own scan/denylist logic is meant to target
    // (system apps are intentionally out of scope, same as the original
    // LSPosed module's MainActivity behaviour).
    const res = await exec("pm list packages -3");
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

async function saveDeniedSet(set) {
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

// One combined root exec call that gathers everything the info panel and
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

async function loadLogs() {
    els.logOutput.textContent = "Loading…";
    try {
        // *:S silences everything except our own tag, so this stays readable
        // even on a busy device. -t 500 = last 500 matching lines from the
        // ring buffer (not a live/blocking tail).
        const res = await exec(`logcat -d -t 500 IsolPolicyZygisk:V *:S 2>&1`);
        const text = (res.stdout || "").trim();
        els.logOutput.textContent = text
            ? text
            : "No matching log lines in the buffer yet.\n\nTip: this module's release build intentionally logs very little " +
              "(only denylist hits + real errors). For full per-event tracing, flash the debug build zip instead — " +
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
        showSnackbar(`Module ${action}. Some root managers need a reboot to fully apply this.`);
        state.status = await collectDeviceStatus();
        renderInfoPanel();
    } catch (err) {
        showSnackbar(String(err.message || err), true);
    } finally {
        els.toggleModuleBtn.disabled = false;
    }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderBuildChip() {
    if (BUILD.buildType === "debug") {
        els.buildChip.textContent = "Debug build";
        els.buildChip.className = "chip chip-debug";
    } else if (BUILD.buildType === "release") {
        els.buildChip.textContent = "Release build";
        els.buildChip.className = "chip chip-ok";
    } else {
        els.buildChip.textContent = "Build: unknown";
        els.buildChip.className = "chip";
    }
}

function fmtTimestamp(epochSeconds) {
    const n = Number(epochSeconds);
    if (!n) return "Never";
    const d = new Date(n * 1000);
    return d.toLocaleDateString(undefined, { day: "2-digit", month: "short" }) +
        " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function updateStats() {
    els.statInstalled.textContent = state.packages.length;
    els.statDenied.textContent = state.denied.size;
    els.statUpdated.textContent = state.status ? fmtTimestamp(state.status.DENIED_MTIME) : "–";
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

function renderInfoPanel() {
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

    els.toggleModuleBtn.textContent = enabled ? "Disable module" : "Enable module";
    els.toggleModuleBtn.className = "btn btn-outlined" + (enabled ? " btn-danger" : "");
}

function render() {
    const q = state.filter.trim().toLowerCase();
    const frag = document.createDocumentFragment();
    let shown = 0;

    for (const pkg of state.packages) {
        if (q && !pkg.toLowerCase().includes(q)) continue;
        shown++;

        const isDenied = state.denied.has(pkg);

        const row = document.createElement("div");
        row.className = "row" + (isDenied ? " row-denied" : "");

        const text = document.createElement("span");
        text.className = "pkg";
        text.textContent = pkg;

        const sw = document.createElement("label");
        sw.className = "md-switch";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = isDenied;
        cb.setAttribute("aria-label", `Deny isolated services for ${pkg}`);
        cb.addEventListener("change", () => {
            if (cb.checked) state.denied.add(pkg);
            else state.denied.delete(pkg);
            row.classList.toggle("row-denied", cb.checked);
            updateStats();
        });

        const track = document.createElement("span");
        track.className = "track";
        const thumb = document.createElement("span");
        thumb.className = "thumb";

        sw.appendChild(cb);
        sw.appendChild(track);
        sw.appendChild(thumb);

        row.addEventListener("click", (e) => {
            if (e.target.closest(".md-switch")) return; // switch handles its own toggling
            cb.checked = !cb.checked;
            cb.dispatchEvent(new Event("change"));
        });

        row.appendChild(text);
        row.appendChild(sw);
        frag.appendChild(row);
    }

    els.list.innerHTML = "";
    els.list.appendChild(frag);
    els.empty.style.display = shown === 0 ? "block" : "none";
    updateStats();
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function refresh() {
    showSnackbar("Loading installed apps…");
    els.refreshBtn.disabled = true;
    try {
        const [packages, denied, status] = await Promise.all([
            loadInstalledPackages(),
            loadDeniedSet(),
            collectDeviceStatus(),
        ]);
        state.packages = packages;
        state.denied = denied;
        state.status = status;
        render();
        renderInfoPanel();
        showSnackbar(`Loaded ${packages.length} apps.`);
    } catch (err) {
        showSnackbar(String(err.message || err), true);
    } finally {
        els.refreshBtn.disabled = false;
    }
}

async function apply() {
    showSnackbar("Saving…");
    els.applyBtn.disabled = true;
    try {
        await saveDeniedSet(state.denied);
        state.status = await collectDeviceStatus();
        updateStats();
        renderInfoPanel();
        showSnackbar(`Saved. ${state.denied.size} package(s) denied.`);
    } catch (err) {
        showSnackbar(String(err.message || err), true);
    } finally {
        els.applyBtn.disabled = false;
    }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
function init() {
    els.list = $("list");
    els.empty = $("empty");
    els.search = $("search");
    els.refreshBtn = $("refresh");
    els.applyBtn = $("apply");
    els.snackbar = $("snackbar");

    els.statInstalled = $("statInstalled");
    els.statDenied = $("statDenied");
    els.statUpdated = $("statUpdated");

    els.infoToggle = $("infoToggle");
    els.infoPanel = $("infoPanel");
    els.infoGrid = $("infoGrid");
    els.buildChip = $("buildChip");
    els.toggleModuleBtn = $("toggleModuleBtn");
    els.viewLogsBtn = $("viewLogsBtn");

    els.logPanel = $("logPanel");
    els.logOutput = $("logOutput");
    els.refreshLogsBtn = $("refreshLogsBtn");
    els.closeLogsBtn = $("closeLogsBtn");

    renderBuildChip();
    renderInfoPanel();

    els.search.addEventListener("input", () => {
        state.filter = els.search.value;
        render();
    });
    els.refreshBtn.addEventListener("click", refresh);
    els.applyBtn.addEventListener("click", apply);

    els.infoToggle.addEventListener("click", () => {
        const willShow = els.infoPanel.hidden;
        els.infoPanel.hidden = !willShow;
        els.infoToggle.setAttribute("aria-expanded", String(willShow));
    });
    els.toggleModuleBtn.addEventListener("click", toggleModule);
    els.viewLogsBtn.addEventListener("click", () => {
        els.logPanel.hidden = false;
        loadLogs();
    });
    els.refreshLogsBtn.addEventListener("click", loadLogs);
    els.closeLogsBtn.addEventListener("click", () => { els.logPanel.hidden = true; });

    if (!hasRootBridge()) {
        els.empty.textContent =
            "No root WebUI bridge detected. Open this page from your root manager's " +
            "module Action button (KernelSU / APatch / Magisk WebUI).";
        els.empty.style.display = "block";
        showSnackbar("No root WebUI bridge detected.", true);
        return;
    }

    refresh();
}

document.addEventListener("DOMContentLoaded", init);
