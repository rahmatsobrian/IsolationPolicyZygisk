/*
 * Tiny, dependency-free i18n helper.
 *
 * Not a build-time locale pipeline like Tricky Addon / PIF's webui/public/locales
 * (this module ships as plain static files, no bundler) - instead both
 * dictionaries are embedded directly here and applied to the DOM via
 * data-i18n / data-i18n-placeholder attributes, with the active language
 * persisted in localStorage.
 */
const STRINGS = {
    en: {
        app_title: "Isolation Policy",
        app_subtitle: "Block isolated / app-zygote services per app",
        search_placeholder: "Search by package name…",
        stat_installed: "Installed",
        stat_denied: "Denied",
        stat_saved: "Last saved",
        chip_all: "All",
        chip_denied: "Denied",
        chip_allowed: "Allowed",
        chip_pending: "Unsaved",
        empty_default: "No apps match your search.",
        empty_no_bridge: "No root WebUI bridge detected. Open this page from your root manager's module Action button (KernelSU / APatch / Magisk WebUI).",
        fab_apply: "Apply changes",
        menu_title: "Menu",
        menu_select_all: "Select all visible",
        menu_deselect_all: "Deselect all visible",
        menu_invert: "Invert visible selection",
        menu_refresh: "Refresh app list",
        menu_scope: "App scope",
        menu_sort: "Sort order",
        menu_backup: "Backup & restore",
        menu_settings: "Settings",
        menu_status: "Module status",
        menu_help: "Help",
        menu_about: "About",
        scope_title: "App scope",
        scope_user: "User apps",
        scope_system: "System apps",
        scope_all: "All apps",
        sort_title: "Sort order",
        sort_name: "Name (A–Z)",
        sort_denied: "Denied first",
        sort_pending: "Unsaved changes first",
        status_title: "Module status",
        status_view_logs: "View logs",
        logs_title: "Recent logs",
        backup_title: "Backup & restore",
        backup_export_label: "Export denylist",
        backup_export_hint: "Writes the current saved denylist to this file.",
        backup_export_btn: "Export",
        backup_import_label: "Import denylist",
        backup_import_hint: "Reads package names (one per line) from this file.",
        backup_import_replace: "Replace instead of merge",
        backup_import_replace_desc: "Off = add to current selection",
        backup_import_btn: "Import",
        backup_clipboard_label: "Clipboard",
        backup_copy: "Copy list",
        settings_title: "Settings",
        settings_compact: "Compact list density",
        settings_compact_desc: "Fit more apps on screen",
        settings_confirm: "Confirm before applying",
        settings_confirm_desc: "Ask before writing the denylist",
        settings_haptics: "Haptic feedback",
        settings_haptics_desc: "Vibrate on toggle, when supported",
        settings_language: "Language",
        help_title: "Help",
        about_author: "By RahmatSobrian, mhmrdd",
        about_desc: "Zygisk port of the Isolation-Policy LSPosed module — blocks isolated / app-zygote service processes for the apps you choose, no Xposed framework required.",
        about_disclaimer: "This module is provided as-is, without warranty. Denying isolated services for an app may break features that rely on them (WebView sandboxing, some media/DRM codecs, etc.) — if something stops working after enabling a deny, disable it for that app first.",
        loading_status: "Loading device & module status…",
        loading_generic: "Loading…",
        dlg_cancel: "Cancel",
        dlg_ok: "Apply",

        toast_loading_apps: "Loading installed apps…",
        toast_loaded_apps: "Loaded {n} app(s).",
        toast_saving: "Saving…",
        toast_saved: "Saved. {n} package(s) denied.",
        toast_undo: "Undo",
        toast_reverted: "Reverted to the last saved state.",
        toast_module_toggled: "Module {state}. Some root managers need a reboot to fully apply this.",
        toast_enabled: "enabled",
        toast_disabled: "disabled",
        toast_confirm_apply: "Apply {n} pending change(s)?",
        toast_no_bridge: "No root WebUI bridge detected.",
        toast_export_ok: "Exported {n} package(s) to {path}",
        toast_import_ok: "Imported {n} package(s) from {path}",
        toast_copied: "Copied denylist to clipboard.",
        toast_copy_failed: "Couldn't access the clipboard on this WebView.",
        toast_error_generic: "Something went wrong: {msg}",

        help_html:
            "<div class=\"help-instruction\"><p><b>1. Pick apps.</b></p><ul>" +
            "<li>Tap anywhere on a row to toggle whether its isolated / app-zygote services are denied.</li>" +
            "<li>Use the search icon to filter by package name, and the chips below the stats to quickly view Denied / Allowed / Unsaved apps.</li>" +
            "</ul></div>" +
            "<div class=\"help-instruction\"><p><b>2. Apply.</b></p><ul>" +
            "<li>Changes are staged locally until you tap <i>Apply changes</i> - nothing is written to disk before that.</li>" +
            "<li>After applying, a short-lived Undo action lets you restore the previous saved state.</li>" +
            "</ul></div>" +
            "<div class=\"help-instruction\"><p><b>3. App scope.</b></p><ul>" +
            "<li>By default only user-installed apps are listed. Switch to System apps or All apps from the menu if you need to deny a preinstalled app.</li>" +
            "</ul></div>" +
            "<div class=\"help-instruction\"><p><b>4. Backup &amp; restore.</b></p><ul>" +
            "<li>Export writes your saved denylist to a text file you choose (defaults to /sdcard/Download).</li>" +
            "<li>Import reads package names back in, either merging with or replacing your current selection.</li>" +
            "</ul></div>" +
            "<div class=\"help-instruction\"><p><b>5. Module status.</b></p><ul>" +
            "<li>Shows your root manager, Zygisk provider, and whether the native library matches your device's ABI - useful for troubleshooting.</li>" +
            "</ul></div>",
    },
    id: {
        app_title: "Isolation Policy",
        app_subtitle: "Blokir layanan isolated / app-zygote per aplikasi",
        search_placeholder: "Cari berdasarkan nama paket…",
        stat_installed: "Terpasang",
        stat_denied: "Diblokir",
        stat_saved: "Terakhir disimpan",
        chip_all: "Semua",
        chip_denied: "Diblokir",
        chip_allowed: "Diizinkan",
        chip_pending: "Belum disimpan",
        empty_default: "Tidak ada aplikasi yang cocok dengan pencarian.",
        empty_no_bridge: "Jembatan root WebUI tidak terdeteksi. Buka halaman ini dari tombol Action modul di root manager kamu (KernelSU / APatch / Magisk WebUI).",
        fab_apply: "Terapkan perubahan",
        menu_title: "Menu",
        menu_select_all: "Pilih semua yang tampil",
        menu_deselect_all: "Batal pilih semua yang tampil",
        menu_invert: "Balik pilihan yang tampil",
        menu_refresh: "Segarkan daftar aplikasi",
        menu_scope: "Cakupan aplikasi",
        menu_sort: "Urutan",
        menu_backup: "Cadangkan & pulihkan",
        menu_settings: "Pengaturan",
        menu_status: "Status modul",
        menu_help: "Bantuan",
        menu_about: "Tentang",
        scope_title: "Cakupan aplikasi",
        scope_user: "Aplikasi pengguna",
        scope_system: "Aplikasi sistem",
        scope_all: "Semua aplikasi",
        sort_title: "Urutan",
        sort_name: "Nama (A–Z)",
        sort_denied: "Diblokir lebih dulu",
        sort_pending: "Perubahan belum disimpan lebih dulu",
        status_title: "Status modul",
        status_view_logs: "Lihat log",
        logs_title: "Log terbaru",
        backup_title: "Cadangkan & pulihkan",
        backup_export_label: "Ekspor daftar blokir",
        backup_export_hint: "Menulis daftar blokir yang tersimpan ke file ini.",
        backup_export_btn: "Ekspor",
        backup_import_label: "Impor daftar blokir",
        backup_import_hint: "Membaca nama paket (satu per baris) dari file ini.",
        backup_import_replace: "Ganti, bukan gabungkan",
        backup_import_replace_desc: "Mati = tambahkan ke pilihan saat ini",
        backup_import_btn: "Impor",
        backup_clipboard_label: "Clipboard",
        backup_copy: "Salin daftar",
        settings_title: "Pengaturan",
        settings_compact: "Tampilan daftar ringkas",
        settings_compact_desc: "Muat lebih banyak aplikasi di layar",
        settings_confirm: "Konfirmasi sebelum menerapkan",
        settings_confirm_desc: "Tanya dulu sebelum menulis daftar blokir",
        settings_haptics: "Getaran umpan balik",
        settings_haptics_desc: "Bergetar saat toggle, jika didukung",
        settings_language: "Bahasa",
        help_title: "Bantuan",
        about_author: "Oleh RahmatSobrian, mhmrdd",
        about_desc: "Port Zygisk dari modul LSPosed Isolation-Policy — memblokir proses layanan isolated / app-zygote untuk aplikasi pilihanmu, tanpa perlu framework Xposed.",
        about_disclaimer: "Modul ini disediakan apa adanya, tanpa jaminan. Memblokir layanan isolated untuk suatu aplikasi bisa merusak fitur yang bergantung padanya (sandboxing WebView, sebagian codec media/DRM, dll) — jika ada yang berhenti berfungsi setelah blokir diaktifkan, nonaktifkan dulu untuk aplikasi tersebut.",
        loading_status: "Memuat status perangkat & modul…",
        loading_generic: "Memuat…",
        dlg_cancel: "Batal",
        dlg_ok: "Terapkan",

        toast_loading_apps: "Memuat aplikasi terpasang…",
        toast_loaded_apps: "{n} aplikasi dimuat.",
        toast_saving: "Menyimpan…",
        toast_saved: "Tersimpan. {n} paket diblokir.",
        toast_undo: "Batalkan",
        toast_reverted: "Dikembalikan ke status tersimpan terakhir.",
        toast_module_toggled: "Modul {state}. Beberapa root manager perlu reboot agar berlaku sepenuhnya.",
        toast_enabled: "diaktifkan",
        toast_disabled: "dinonaktifkan",
        toast_confirm_apply: "Terapkan {n} perubahan yang belum disimpan?",
        toast_no_bridge: "Jembatan root WebUI tidak terdeteksi.",
        toast_export_ok: "{n} paket diekspor ke {path}",
        toast_import_ok: "{n} paket diimpor dari {path}",
        toast_copied: "Daftar blokir disalin ke clipboard.",
        toast_copy_failed: "Tidak bisa mengakses clipboard di WebView ini.",
        toast_error_generic: "Terjadi kesalahan: {msg}",

        help_html:
            "<div class=\"help-instruction\"><p><b>1. Pilih aplikasi.</b></p><ul>" +
            "<li>Ketuk di mana saja pada baris untuk mengubah apakah layanan isolated / app-zygote aplikasi tersebut diblokir.</li>" +
            "<li>Gunakan ikon pencarian untuk memfilter berdasarkan nama paket, dan chip di bawah statistik untuk melihat aplikasi Diblokir / Diizinkan / Belum disimpan.</li>" +
            "</ul></div>" +
            "<div class=\"help-instruction\"><p><b>2. Terapkan.</b></p><ul>" +
            "<li>Perubahan hanya tersimpan sementara sampai kamu menekan <i>Terapkan perubahan</i> - tidak ada yang ditulis ke penyimpanan sebelum itu.</li>" +
            "<li>Setelah diterapkan, aksi Batalkan yang muncul sebentar memungkinkanmu mengembalikan ke status tersimpan sebelumnya.</li>" +
            "</ul></div>" +
            "<div class=\"help-instruction\"><p><b>3. Cakupan aplikasi.</b></p><ul>" +
            "<li>Secara default hanya aplikasi yang dipasang pengguna yang ditampilkan. Beralih ke Aplikasi sistem atau Semua aplikasi dari menu jika perlu memblokir aplikasi bawaan.</li>" +
            "</ul></div>" +
            "<div class=\"help-instruction\"><p><b>4. Cadangkan &amp; pulihkan.</b></p><ul>" +
            "<li>Ekspor menulis daftar blokir tersimpan ke file teks pilihanmu (default ke /sdcard/Download).</li>" +
            "<li>Impor membaca kembali nama paket, baik digabung dengan maupun menggantikan pilihan saat ini.</li>" +
            "</ul></div>" +
            "<div class=\"help-instruction\"><p><b>5. Status modul.</b></p><ul>" +
            "<li>Menampilkan root manager, penyedia Zygisk, dan apakah native library cocok dengan ABI perangkatmu - berguna untuk pemecahan masalah.</li>" +
            "</ul></div>",
    },
};

const i18n = {
    lang: "en",

    init() {
        const saved = localStorage.getItem("isolpolicy_lang");
        if (saved && STRINGS[saved]) {
            this.lang = saved;
        } else {
            const nav = (navigator.language || "en").toLowerCase();
            this.lang = nav.startsWith("id") ? "id" : "en";
        }
    },

    setLang(lang) {
        if (!STRINGS[lang]) return;
        this.lang = lang;
        localStorage.setItem("isolpolicy_lang", lang);
        this.apply(document);
    },

    t(key, vars) {
        let str = (STRINGS[this.lang] && STRINGS[this.lang][key]) || STRINGS.en[key] || key;
        if (vars) {
            for (const k in vars) str = str.replace(`{${k}}`, vars[k]);
        }
        return str;
    },

    apply(root) {
        root.querySelectorAll("[data-i18n]").forEach((el) => {
            el.textContent = this.t(el.getAttribute("data-i18n"));
        });
        root.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
            el.setAttribute("placeholder", this.t(el.getAttribute("data-i18n-placeholder")));
        });
    },
};

i18n.init();
