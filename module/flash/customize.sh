SKIPUNZIP=0

POLICY_DIR="/data/adb/isolationpolicy"
POLICY_FILE="$POLICY_DIR/denied.list"

ui_print "- Isolation Policy (Zygisk)"

# Zygisk must be enabled (Magisk Zygisk toggle, or ReZygisk/NeoZygisk installed).
if [ -d "/data/adb/modules/zygisksu" ] || [ -d "/data/adb/modules/rezygisk" ] || \
   [ -d "/data/adb/modules/brezygisk" ] || [ -e "/data/adb/zygisk_enabled" ] || \
   [ "$ZYGISK_ENABLED" = "1" ]; then
    ui_print "- Zygisk provider detected"
else
    ui_print "- WARNING: could not confirm a Zygisk provider is active."
    ui_print "  Make sure Magisk Zygisk is ON, or ReZygisk/NeoZygisk/BreZygisk is installed."
fi

# Policy storage lives outside the module directory on purpose, so it
# survives module updates (which re-extract this zip over /data/adb/modules/<id>).
# Only create it if missing - never overwrite an existing denylist.
mkdir -p "$POLICY_DIR"
if [ ! -f "$POLICY_FILE" ]; then
    touch "$POLICY_FILE"
    ui_print "- Created empty denylist at $POLICY_FILE"
else
    ui_print "- Existing denylist found at $POLICY_FILE, keeping it"
fi
chmod 700 "$POLICY_DIR"
chmod 600 "$POLICY_FILE"

ui_print "- Manage the denylist from the module's WebUI (Action button in your root manager)"
