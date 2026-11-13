import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const VERTICAL_ACTIONS = [
    'Show Activities',
    'Volume Up / Down',
    'Brightness Up / Down',
    'Maximize / Minimize',
    'Close Window',
    'Show Desktop',
    'Custom Keybind',
    'Disabled',
];

const LEFT_ACTIONS = [
    'Workspace Left',
    'Brightness Down',
    'Alt+Tab — Previous App',
    'Previous Media Track',
    'Custom Keybind',
    'Disabled',
];

const RIGHT_ACTIONS = [
    'Workspace Right',
    'Brightness Up',
    'Alt+Tab — Next App',
    'Next Media Track',
    'Custom Keybind',
    'Disabled',
];

const TAP_ACTIONS = [
    'Play / Pause Media',
    'Show Desktop',
    'Cycle Workspaces',
    'Show Notifications',
    'Custom Keybind',
    'Disabled',
];

const _MODIFIER_KEYVALS = new Set([
    0,
    65505,
    65506,
    65507,
    65508,
    65509,
    65510,
    65511,
    65512,
    65513,
    65514,
    65515,
    65516,
    65517,
    65518,
    65027,
    65407,
    65300,
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

        const rows = [
            [group3, 'Swipe Up', 'three-swipe-up', VERTICAL_ACTIONS],
            [group3, 'Swipe Down', 'three-swipe-down', VERTICAL_ACTIONS],
            [group3, 'Swipe Left', 'three-swipe-left', LEFT_ACTIONS],
            [group3, 'Swipe Right', 'three-swipe-right', RIGHT_ACTIONS],
            [group3, 'Three-Finger Tap', 'three-tap', TAP_ACTIONS],
            [group4, 'Swipe Up', 'four-swipe-up', VERTICAL_ACTIONS],
            [group4, 'Swipe Down', 'four-swipe-down', VERTICAL_ACTIONS],
            [group4, 'Swipe Left', 'four-swipe-left', LEFT_ACTIONS],
            [group4, 'Swipe Right', 'four-swipe-right', RIGHT_ACTIONS],
            [group4, 'Four-Finger Tap', 'four-tap', TAP_ACTIONS],
        ];

        for (const [group, title, prefix, actions] of rows)
            this._buildRow(window, group, title, prefix, actions, settings);
    }

    _buildRow(window, group, title, prefix, actions, settings) {
        const customIndex = actions.indexOf('Custom Keybind');

        const combo = new Adw.ComboRow({
            title,
            model: new Gtk.StringList({ strings: actions }),
        });
        settings.bind(`${prefix}-action`, combo, 'selected', Gio.SettingsBindFlags.DEFAULT);
        group.add(combo);

        if (customIndex === -1) return;

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

        const updateVisibility = () => {
            keybindRow.visible = combo.selected === customIndex;
        };
        combo.connect('notify::selected', updateVisibility);
        updateVisibility();

        settings.connect(`changed::${prefix}-keybind`, () => {
            keybindRow.subtitle = this._keybindLabel(settings.get_string(`${prefix}-keybind`));
        });

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

            let currentMods = 0;
            let captured = false;

            const keyCtrl = new Gtk.EventControllerKey();
            keyCtrl.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
            dialog.add_controller(keyCtrl);

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

                if (keyval === Gdk.KEY_Escape && !(state & Gtk.accelerator_get_default_mod_mask())) {
                    dialog.close();
                    return true;
                }

                const mods = state & Gtk.accelerator_get_default_mod_mask();

                if (_isModifierKey(keyval)) {
                    currentMods = mods;
                    _updateModLabel(mods);
                    return true;
                }

                captured = true;

                let finalKeyval = keyval;

                if (keyval >= Gdk.KEY_A && keyval <= Gdk.KEY_Z) {
                    finalKeyval = keyval - Gdk.KEY_A + Gdk.KEY_a;
                }

                const stored = `${finalKeyval}:${mods}`;
                settings.set_string(`${prefix}-keybind`, stored);

                const accelName = Gtk.accelerator_get_label(finalKeyval, mods);
                const displayLabel = accelName || Gtk.accelerator_name(finalKeyval, mods) || stored;
                keybindRow.subtitle = `Recorded: ${displayLabel}`;

                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                    dialog.close();
                    return GLib.SOURCE_REMOVE;
                });
                return true;
            });

            keyCtrl.connect('key-released', (_ctrl, keyval, _keycode, state) => {
                if (captured) return;
                const mods = state & Gtk.accelerator_get_default_mod_mask();

                _updateModLabel(mods);
            });

            keyCtrl.connect('modifiers', (_ctrl, state) => {
                if (captured) return true;
                currentMods = state & Gtk.accelerator_get_default_mod_mask();
                _updateModLabel(currentMods);
                return true;
            });

            dialog.present();

            try {
                const surface = dialog.get_surface?.() ?? null;
                if (surface) surface.inhibit_system_shortcuts(null);
            } catch (_) { }
        });

        clearBtn.connect('clicked', () => {
            settings.set_string(`${prefix}-keybind`, '');
            keybindRow.subtitle = 'Not set';
        });
    }

    _keybindLabel(stored) {
        if (!stored || !stored.includes(':')) return 'Not set — click Record';
        const [kv, mod] = stored.split(':').map(Number);
        if (!kv) return 'Not set — click Record';

        const pretty = Gtk.accelerator_get_label(kv, mod);
        if (pretty && pretty.length > 0) return `Bound: ${pretty}`;

        const name = Gtk.accelerator_name(kv, mod);
        return name ? `Bound: ${name}` : `Bound: keyval ${kv} mod ${mod}`;
    }
}
