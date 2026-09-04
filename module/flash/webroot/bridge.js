/*
 * Minimal root-shell exec bridge for this module's WebUI.
 *
 * KernelSU, APatch, and MMRL's WebUI-X (which recent Magisk WebUI also
 * targets) all expose a global `ksu` object with:
 *
 *   ksu.exec(command, optionsJson, callbackFunctionName)
 *
 * ...which runs `command` as root and calls `window[callbackFunctionName]`
 * with (errno, stdout, stderr). This wraps that callback style into a
 * Promise so the rest of app.js can just `await`.
 */

let callbackCounter = 0;

function uniqueCallbackName(prefix) {
    return `${prefix}_cb_${Date.now()}_${callbackCounter++}`;
}

function hasRootBridge() {
    return typeof window.ksu !== "undefined";
}

function exec(command) {
    if (!hasRootBridge()) {
        return Promise.reject(
            new Error("No root WebUI bridge found (window.ksu is undefined). " +
                "Open this page from your root manager's module Action button.")
        );
    }

    return new Promise((resolve, reject) => {
        const cbName = uniqueCallbackName("exec");
        window[cbName] = (errno, stdout, stderr) => {
            delete window[cbName];
            resolve({ errno, stdout: stdout || "", stderr: stderr || "" });
        };
        try {
            window.ksu.exec(command, JSON.stringify({}), cbName);
        } catch (err) {
            delete window[cbName];
            reject(err);
        }
    });
}

/*
 * Newer KernelSU / KernelSU-Next / APatch webviews additionally expose:
 *
 *   ksu.getPackagesInfo(packageNamesJson) -> packagesInfoJson
 *
 * Unlike ksu.exec/ksu.spawn this one is NOT callback-based - it's a plain
 * synchronous call that takes a JSON-stringified array of package names and
 * immediately returns a JSON-stringified array of PackagesInfo objects
 * ({ packageName, versionName, versionCode, appLabel, isSystem, uid }). No
 * shell round trip, no callback bookkeeping needed.
 *
 * This lets us resolve every installed app's display name (and the aapt
 * badging fields we don't otherwise have) in one call instead of shelling
 * out to aapt per-package.
 */
function hasPackagesInfoBridge() {
    return hasRootBridge() && typeof window.ksu.getPackagesInfo === "function";
}

function getPackagesInfo(pkgs) {
    if (!hasPackagesInfoBridge() || !Array.isArray(pkgs) || pkgs.length === 0) return [];
    try {
        const infoJson = window.ksu.getPackagesInfo(JSON.stringify(pkgs));
        const result = JSON.parse(infoJson);
        return Array.isArray(result) ? result : [];
    } catch (err) {
        console.warn("ksu.getPackagesInfo failed:", err);
        return [];
    }
}
