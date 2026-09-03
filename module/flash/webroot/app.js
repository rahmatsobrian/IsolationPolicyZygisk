const POLICY_DIR = "/data/adb/isolationpolicy";
const POLICY_FILE = `${POLICY_DIR}/denied.list`;
const PKG_RE = /^[a-zA-Z][a-zA-Z0-9_.]*$/;

const state = {
    packages: [],   // [{pkg, label}]
    denied: new Set(),
    filter: "",
};

const els = {};

function $(id) { return document.getElementById(id); }

function setStatus(text, isError) {
    els.status.textContent = text;
    els.status.classList.toggle("error", !!isError);
}

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

function render() {
    const q = state.filter.trim().toLowerCase();
    const frag = document.createDocumentFragment();
    let shown = 0;

    for (const pkg of state.packages) {
        if (q && !pkg.toLowerCase().includes(q)) continue;
        shown++;

        const row = document.createElement("label");
        row.className = "row";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = state.denied.has(pkg);
        cb.addEventListener("change", () => {
            if (cb.checked) state.denied.add(pkg);
            else state.denied.delete(pkg);
            updateCounts();
        });

        const text = document.createElement("span");
        text.className = "pkg";
        text.textContent = pkg;

        row.appendChild(cb);
        row.appendChild(text);
        frag.appendChild(row);
    }

    els.list.innerHTML = "";
    els.list.appendChild(frag);
    els.empty.style.display = shown === 0 ? "block" : "none";
    updateCounts();
}

function updateCounts() {
    els.counts.textContent =
        `${state.packages.length} apps installed · ${state.denied.size} denied`;
}

async function refresh() {
    setStatus("Loading installed apps…");
    els.refreshBtn.disabled = true;
    try {
        const [packages, denied] = await Promise.all([
            loadInstalledPackages(),
            loadDeniedSet(),
        ]);
        state.packages = packages;
        state.denied = denied;
        render();
        setStatus(`Loaded ${packages.length} apps.`);
    } catch (err) {
        setStatus(String(err.message || err), true);
    } finally {
        els.refreshBtn.disabled = false;
    }
}

async function apply() {
    setStatus("Saving…");
    els.applyBtn.disabled = true;
    try {
        await saveDeniedSet(state.denied);
        setStatus(`Saved. ${state.denied.size} package(s) denied.`);
    } catch (err) {
        setStatus(String(err.message || err), true);
    } finally {
        els.applyBtn.disabled = false;
    }
}

function init() {
    els.status = $("status");
    els.list = $("list");
    els.empty = $("empty");
    els.counts = $("counts");
    els.search = $("search");
    els.refreshBtn = $("refresh");
    els.applyBtn = $("apply");

    els.search.addEventListener("input", () => {
        state.filter = els.search.value;
        render();
    });
    els.refreshBtn.addEventListener("click", refresh);
    els.applyBtn.addEventListener("click", apply);

    if (!hasRootBridge()) {
        setStatus(
            "No root WebUI bridge detected. Open this page from your root " +
            "manager's module Action button (KernelSU / APatch / Magisk WebUI).",
            true
        );
        return;
    }

    refresh();
}

document.addEventListener("DOMContentLoaded", init);
