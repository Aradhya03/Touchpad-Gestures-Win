/**
 * prefs.js  —  Custom Touchpad Gestures preferences
 * uuid: touchpad-gestures@alpha.com
 *
 * FIXES vs previous broken versions
 * ══════════════════════════════════
 * 1. EventControllerKey uses Gtk.PropagationPhase.CAPTURE so it intercepts
 *    key events BEFORE any widget (including the focused Record button) can
 *    consume them. Without this, pressing Enter/Space activates the button
 *    instead of being recorded as a keybind.
 *
 * 2. Modifier-only keys (Shift, Ctrl, Alt, Super) are properly skipped using
 *    Gdk keyval ranges — we wait for the actual non-modifier key.
 *
 * 3. Keybind is stored as "KEYVAL:MODMASK" decimal integers — not as a Gtk
 *    accelerator string — so extension.js can parse it without any Gtk API.
 *
 * 4. The controller is created fresh on each Record click and destroyed on
 *    Stop/save — no stale controllers accumulating on the window.
 *
 * 5. Action lists and their indices exactly match the constants in extension.js.
 */

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// ── Action lists — ORDER MUST MATCH constants in extension.js ────────────────

// Vertical: index 0-6 matches V.* in extension.js
const VERTICAL_ACTIONS = [
    'Show Activities',          // 0
    'Volume Up / Down',         // 1
    'Brightness Up / Down',     // 2
    'Maximize / Minimize',      // 3
    'Close Window',             // 4
    'Show Desktop',             // 5
    'Custom Keybind',           // 6
    'Disabled',                 // 7
];

// Left: index 0-5 matches L.* in extension.js
const LEFT_ACTIONS = [
    'Workspace Left',           // 0
    'Brightness Down',          // 1
    'Alt+Tab — Previous App',   // 2
    'Previous Media Track',     // 3
    'Custom Keybind',           // 4
    'Disabled',                 // 5
];

// Right: index 0-5 matches R.* in extension.js
const RIGHT_ACTIONS = [
    'Workspace Right',          // 0
    'Brightness Up',            // 1
    'Alt+Tab — Next App',       // 2
    'Next Media Track',         // 3
    'Custom Keybind',           // 4
    'Disabled',                 // 5
];

// Tap: index 0-5 matches T.* in extension.js
const TAP_ACTIONS = [
    'Play / Pause Media',       // 0
    'Show Desktop',             // 1
    'Cycle Workspaces',         // 2
    'Show Notifications',       // 3
    'Custom Keybind',           // 4
    'Disabled',                 // 5
];

// Gdk keyvals that are pure modifier keys — skip these during recording.
// ONLY actual modifier keys are listed here. DO NOT use a broad range —
// keys like Print (0xFF61), F1-F12 (0xFFBE-0xFFC9), arrows, Home, End,
// Insert, Delete, Page Up/Down all live in 0xFE01-0xFFFF and MUST be recordable.
const _MODIFIER_KEYVALS = new Set([
    0,          // Voidsymbol / no key
    65505,      // Shift_L
    65506,      // Shift_R
    65507,      // Control_L
    65508,      // Control_R
    65509,      // Caps_Lock
    65510,      // Shift_Lock
    65511,      // Meta_L
    65512,      // Meta_R
    65513,      // Alt_L
    65514,      // Alt_R
    65515,      // Super_L
    65516,      // Super_R
    65517,      // Hyper_L
    65518,      // Hyper_R
    65027,      // ISO_Level3_Shift (AltGr)
    65407,      // Num_Lock
    65300,      // Scroll_Lock
]);
const _isModifierKey = keyval => _MODIFIER_KEYVALS.has(keyval);

export default class TouchpadGesturesPreferences extends ExtensionPreferences {

    fillPreferencesWindow(window) {
        const settings = this.getSettings('org.gnome.shell.extensions.touchpad-gestures');

        window.set_default_size(660, 760);
        window.set_title('Touchpad Gestures');

        const page = new Adw.PreferencesPage({
            title: 'Gestures',
            icon_name: 'input-touchpad-symbolic',
        });
        window.add(page);

        const group3 = new Adw.PreferencesGroup({ title: '3-Finger Gestures' });
        const group4 = new Adw.PreferencesGroup({ title: '4-Finger Gestures' });
        page.add(group3);
        page.add(group4);

        // [group, row-title, settings-key-prefix, action-list]
        const rows = [
            [group3, 'Swipe Up',         'three-swipe-up',    VERTICAL_ACTIONS],
            [group3, 'Swipe Down',       'three-swipe-down',  VERTICAL_ACTIONS],
            [group3, 'Swipe Left',       'three-swipe-left',  LEFT_ACTIONS],
            [group3, 'Swipe Right',      'three-swipe-right', RIGHT_ACTIONS],
            [group3, 'Three-Finger Tap', 'three-tap',         TAP_ACTIONS],
            [group4, 'Swipe Up',         'four-swipe-up',     VERTICAL_ACTIONS],
            [group4, 'Swipe Down',       'four-swipe-down',   VERTICAL_ACTIONS],
            [group4, 'Swipe Left',       'four-swipe-left',   LEFT_ACTIONS],
            [group4, 'Swipe Right',      'four-swipe-right',  RIGHT_ACTIONS],
            [group4, 'Four-Finger Tap',  'four-tap',          TAP_ACTIONS],
        ];

        for (const [group, title, prefix, actions] of rows)
            this._buildRow(window, group, title, prefix, actions, settings);
    }

    _buildRow(window, group, title, prefix, actions, settings) {
        const customIndex = actions.indexOf('Custom Keybind');

        // ── Gesture action selector ───────────────────────────────────────────
        const combo = new Adw.ComboRow({
            title,
            model: new Gtk.StringList({ strings: actions }),
        });
        settings.bind(`${prefix}-action`, combo, 'selected', Gio.SettingsBindFlags.DEFAULT);
        group.add(combo);

        // Only show keybind recorder when Custom Keybind is selected
        if (customIndex === -1) return; // Safety: no Custom option in this list

        // ── Keybind recorder row (shown only for Custom Keybind) ─────────────
        const keybindRow = new Adw.ActionRow({
            title: 'Keybind',
            subtitle: this._keybindLabel(settings.get_string(`${prefix}-keybind`)),
        });

        const recordBtn = new Gtk.Button({
            label: 'Record',
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        const clearBtn = new Gtk.Button({
            label: 'Clear',
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        keybindRow.add_suffix(recordBtn);
        keybindRow.add_suffix(clearBtn);
        group.add(keybindRow);

        // Show/hide keybindRow based on combo selection
        const updateVisibility = () => {
            keybindRow.visible = combo.selected === customIndex;
        };
        combo.connect('notify::selected', updateVisibility);
        updateVisibility();

        // Keep subtitle in sync when setting changes elsewhere
        settings.connect(`changed::${prefix}-keybind`, () => {
            keybindRow.subtitle = this._keybindLabel(settings.get_string(`${prefix}-keybind`));
        });

        // ── Recording logic — uses a modal dialog to avoid key interference ────
        recordBtn.connect('clicked', () => {
            const dialog = new Gtk.Window({
                title: 'Record Keybind',
                modal: true,
                transient_for: window,
                default_width: 400,
                default_height: 200,
                resizable: false,
            });

            const box = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 12,
                margin_top: 24, margin_bottom: 24,
                margin_start: 24, margin_end: 24,
                halign: Gtk.Align.CENTER,
                valign: Gtk.Align.CENTER,
            });

            const titleLabel = new Gtk.Label({
                label: 'Press any key combination…',
                css_classes: ['title-3'],
            });

            const feedbackLabel = new Gtk.Label({
                label: '(Press Escape to cancel)',
                css_classes: ['dim-label'],
            });

            box.append(titleLabel);
            box.append(feedbackLabel);
            dialog.set_child(box);

            // Track pressed modifiers live for display feedback
            let currentMods = 0;
            let captured = false;

            const keyCtrl = new Gtk.EventControllerKey();
            keyCtrl.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
            dialog.add_controller(keyCtrl);

            // Update the feedback label with currently held modifiers
            const _updateModLabel = (mods) => {
                const parts = [];
                if (mods & Gdk.ModifierType.CONTROL_MASK) parts.push('Ctrl');
                if (mods & Gdk.ModifierType.ALT_MASK) parts.push('Alt');
                if (mods & Gdk.ModifierType.SHIFT_MASK) parts.push('Shift');
                if (mods & Gdk.ModifierType.SUPER_MASK) parts.push('Super');
                if (mods & Gdk.ModifierType.HYPER_MASK) parts.push('Hyper');
                if (mods & Gdk.ModifierType.META_MASK) parts.push('Meta');
                if (parts.length > 0) {
                    feedbackLabel.label = parts.join(' + ') + ' + …';
                } else {
                    feedbackLabel.label = '(Press Escape to cancel)';
                }
            };

            keyCtrl.connect('key-pressed', (_ctrl, keyval, keycode, state) => {
                if (captured) return true;

                // Escape with no modifiers = cancel
                if (keyval === Gdk.KEY_Escape && !(state & Gtk.accelerator_get_default_mod_mask())) {
                    dialog.close();
                    return true;
                }

                // Clean the state to only keep real modifiers
                const mods = state & Gtk.accelerator_get_default_mod_mask();

                // If it's a modifier-only key, just update feedback display
                if (_isModifierKey(keyval)) {
                    currentMods = mods;
                    _updateModLabel(mods);
                    return true;
                }

                // This is a real key — capture it!
                captured = true;

                // Try to get a more useful keyval from the keycode without modifiers
                // This ensures we get the base key even when Shift changes it
                let finalKeyval = keyval;

                // For letter keys, normalize to lowercase (unshifted)
                // The modifier mask already captures Shift, so we want the base key
                if (keyval >= Gdk.KEY_A && keyval <= Gdk.KEY_Z) {
                    finalKeyval = keyval - Gdk.KEY_A + Gdk.KEY_a;
                }

                const stored = `${finalKeyval}:${mods}`;
                settings.set_string(`${prefix}-keybind`, stored);

                // Build a human-readable label
                const accelName = Gtk.accelerator_get_label(finalKeyval, mods);
                const displayLabel = accelName || Gtk.accelerator_name(finalKeyval, mods) || stored;
                keybindRow.subtitle = `Recorded: ${displayLabel}`;

                // Close after a brief delay so the user sees what was captured
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                    dialog.close();
                    return GLib.SOURCE_REMOVE;
                });
                return true;
            });

            // Update modifier feedback on key release too
            keyCtrl.connect('key-released', (_ctrl, keyval, _keycode, state) => {
                if (captured) return;
                const mods = state & Gtk.accelerator_get_default_mod_mask();
                // Remove the just-released modifier from the display
                _updateModLabel(mods);
            });

            // Also connect modifiers to track state changes
            keyCtrl.connect('modifiers', (_ctrl, state) => {
                if (captured) return true;
                currentMods = state & Gtk.accelerator_get_default_mod_mask();
                _updateModLabel(currentMods);
                return true;
            });

            dialog.present();

            // Inhibit system shortcuts AFTER present() so the surface exists
            try {
                const surface = dialog.get_surface?.() ?? null;
                if (surface) surface.inhibit_system_shortcuts(null);
            } catch (_) {}
        });

        clearBtn.connect('clicked', () => {
            settings.set_string(`${prefix}-keybind`, '');
            keybindRow.subtitle = 'Not set';
        });
    }

    /** Human-readable label for a stored "KEYVAL:MODMASK" string */
    _keybindLabel(stored) {
        if (!stored || !stored.includes(':')) return 'Not set — click Record';
        const [kv, mod] = stored.split(':').map(Number);
        if (!kv) return 'Not set — click Record';
        // Use Gtk.accelerator_get_label for a pretty display (e.g. "Ctrl+Shift+A")
        const pretty = Gtk.accelerator_get_label(kv, mod);
        if (pretty && pretty.length > 0) return `Bound: ${pretty}`;
        // Fallback to accelerator_name (e.g. "<Control><Shift>a")
        const name = Gtk.accelerator_name(kv, mod);
        return name ? `Bound: ${name}` : `Bound: keyval ${kv} mod ${mod}`;
    }
}
