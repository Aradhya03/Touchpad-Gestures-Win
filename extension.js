/**
 * extension.js  —  Custom Touchpad Gestures
 * uuid: touchpad-gestures@alpha.com
 *
 * Tested on: GNOME Shell 50 / Ubuntu 26.04 / Wayland
 *
 * KEY DESIGN DECISIONS
 * ════════════════════
 * 1. Uses 'captured-event::touchpad' (detail-filtered capture phase signal)
 *    to intercept touchpad events BEFORE GNOME's built-in handlers see them.
 *    Returning EVENT_STOP from capture phase prevents bubble-phase handlers.
 *
 * 2. Disables GNOME's built-in swipe trackers at THREE levels:
 *    a) Sets tracker.enabled = false on each SwipeTracker
 *    b) Sets tracker._touchpadGesture.enabled = false (inner gesture object)
 *    c) Disconnects the _touchpadGesture from global.stage via destroy()
 *    This ensures GNOME never processes our touchpad events.
 *
 * 3. Uses GNOME Shell 50 API:
 *    - w.is_maximized() instead of removed w.get_maximized()
 *    - w.maximize() / w.unmaximize() without Meta.MaximizeFlags
 *
 * 4. Delta accumulation across UPDATE phases, direction resolved at END.
 *
 * 5. Hold events detect multi-finger taps (short hold → tap).
 *
 * 6. Actions dispatched via GLib.idle_add to avoid re-entrancy.
 *
 * 7. Volume via Gvc.MixerControl, brightness via D-Bus, media via MPRIS.
 * 8. Volume/Brightness respond continuously during swipe UPDATE phase.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

// ── Swipe detection threshold (accumulated px) ────────────────────────────────
const SWIPE_THRESHOLD = 15;

// ── Tap detection: max duration in ms for a hold to count as tap ──────────────
const TAP_MAX_DURATION_MS = 500;

// ── Volume/Brightness step per swipe-update delta pixel ───────────────────────
const VOL_STEP_PER_PX = 0.0012;
const BRIGHT_STEP_PER_PX = 0.0012;
const OSD_THROTTLE_MS = 120;

// ── MPRIS D-Bus interface XML ─────────────────────────────────────────────────
const MPRIS_PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';

// ── Action indices — MUST match dropdown order in prefs.js ───────────────────
const V = { ACTIVITIES: 0, VOLUME: 1, BRIGHTNESS: 2, MAX_MIN: 3, CLOSE: 4, SHOW_DESKTOP: 5, CUSTOM: 6, DISABLED: 7 };
const L = { WS_LEFT: 0, BRIGHT_DOWN: 1, ALTTAB_PREV: 2, MEDIA_PREV: 3, CUSTOM: 4, DISABLED: 5 };
const R = { WS_RIGHT: 0, BRIGHT_UP: 1, ALTTAB_NEXT: 2, MEDIA_NEXT: 3, CUSTOM: 4, DISABLED: 5 };
const T = { PLAY_PAUSE: 0, SHOW_DESKTOP: 1, CYCLE_WS: 2, NOTIFS: 3, CUSTOM: 4, DISABLED: 5 };

const MAX_V = 7, MAX_L = 5, MAX_R = 5, MAX_T = 5;

export default class TouchpadGesturesExtension extends Extension {

    enable() {
        this._settings = this.getSettings('org.gnome.shell.extensions.touchpad-gestures');

        // Virtual keyboard for key simulation
        const seat = Clutter.get_default_backend().get_default_seat();
        this._kb = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);

        // Gesture state
        this._dx = 0;
        this._dy = 0;
        this._holdStartTime = 0;
        this._holdFingers = 0;

        // Continuous swipe state (for volume/brightness during UPDATE)
        this._swipeContinuousAction = null; // 'volume' | 'brightness' | null
        this._swipeDirectionLocked = false;

        // OSD throttle timestamp
        this._lastOsdTime = 0;

        // Signal connection IDs for cleanup
        this._signalIds = [];

        // Track pending idle/timeout source IDs for cleanup in disable()
        this._pendingSources = new Set();

        // ── Volume subsystem — reuse Shell's built-in MixerControl ────────────
        this._volumeControl = null;

        // ── Disable ALL built-in swipe trackers ──────────────────────────────
        this._savedTrackerState = [];
        this._disableBuiltinTrackers();

        // Re-disable after shell startup
        if (Main.layoutManager._startingUp) {
            const id = Main.layoutManager.connect('startup-complete', () => {
                this._disableBuiltinTrackers();
            });
            this._signalIds.push({ obj: Main.layoutManager, id });
        }

        // Re-disable on overview state changes
        for (const sig of ['showing', 'hidden']) {
            const id = Main.overview.connect(sig, () => {
                this._disableBuiltinTrackers();
            });
            this._signalIds.push({ obj: Main.overview, id });
        }

        // Watchdog: re-disable trackers periodically
        this._watchdogId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
            this._disableBuiltinTrackers();
            return GLib.SOURCE_CONTINUE;
        });

        // ── Connect to touchpad events using detail-filtered capture signal
        this._stageSignalId = global.stage.connect(
            'captured-event::touchpad',
            (_actor, event) => this._onEvent(event)
        );

    }

    disable() {

        if (this._stageSignalId) {
            global.stage.disconnect(this._stageSignalId);
            this._stageSignalId = null;
        }

        if (this._watchdogId) {
            GLib.source_remove(this._watchdogId);
            this._watchdogId = null;
        }

        for (const { obj, id } of this._signalIds) {
            try { obj.disconnect(id); } catch (_) { }
        }
        this._signalIds = [];

        // Remove all pending idle/timeout sources
        if (this._pendingSources) {
            for (const srcId of this._pendingSources) {
                GLib.source_remove(srcId);
            }
            this._pendingSources.clear();
            this._pendingSources = null;
        }

        this._restoreBuiltinTrackers();
        this._kb = null;
        this._settings = null;
        this._volumeControl = null;
    }

    // ── GNOME tracker management
    _disableBuiltinTrackers() {
        const trackerGetters = [
            () => Main.overview?._swipeTracker,
            () => Main.wm?._workspaceAnimation?._swipeTracker,
            () => Main.overview?._overview?.controls?._workspacesDisplay?._swipeTracker,
            () => Main.overview?._overview?.controls?._swipeTracker,
            () => Main.wm?._swipeTracker,
            () => Main.overview?._overview?.controls?._appDisplay?._swipeTracker,
        ];

        for (const getter of trackerGetters) {
            try {
                const tracker = getter();
                if (!tracker) continue;

                // Only save state first time we see this tracker
                if (!this._savedTrackerState.some(s => s.tracker === tracker)) {
                    this._savedTrackerState.push({
                        tracker,
                        wasEnabled: tracker.enabled ?? true,
                        touchpadGestureEnabled: tracker._touchpadGesture?.enabled ?? true,
                    });
                }

                // Level 1: Disable the SwipeTracker itself
                if (tracker.enabled !== undefined)
                    tracker.enabled = false;

                // Level 2: Disable the internal TouchpadSwipeGesture
                if (tracker._touchpadGesture) {
                    tracker._touchpadGesture.enabled = false;
                }

                // Level 3: Disable internal PanGesture action
                if (tracker._panGesture) {
                    tracker._panGesture.enabled = false;
                }
            } catch (e) {
                // Path doesn't exist on this GNOME version — ignore
            }
        }
    }

    _restoreBuiltinTrackers() {
        for (const saved of this._savedTrackerState) {
            try {
                if (saved.tracker.enabled !== undefined)
                    saved.tracker.enabled = saved.wasEnabled;
                if (saved.tracker._touchpadGesture)
                    saved.tracker._touchpadGesture.enabled = saved.touchpadGestureEnabled;
                if (saved.tracker._panGesture)
                    saved.tracker._panGesture.enabled = true;
            } catch (_) { }
        }
        this._savedTrackerState = [];
    }

    // ── Raw event handler ─────────────────────────────────────────────────────

    _onEvent(event) {
        const type = event.type();

        // ── Touchpad SWIPE ────────────────────────────────────────────────────
        if (type === Clutter.EventType.TOUCHPAD_SWIPE) {
            const n = event.get_touchpad_gesture_finger_count();
            const phase = event.get_gesture_phase();

            // Only handle 3 and 4 finger gestures
            if (n < 3 || n > 4) return Clutter.EVENT_PROPAGATE;

            if (phase === Clutter.TouchpadGesturePhase.BEGIN) {
                this._dx = 0;
                this._dy = 0;
                this._swipeStartTime = GLib.get_monotonic_time();
                this._swipeContinuousAction = null;
                this._swipeDirectionLocked = false;
                this._swipePrefix = n === 4 ? 'four' : 'three';
                return Clutter.EVENT_STOP;
            }

            if (phase === Clutter.TouchpadGesturePhase.UPDATE) {
                const [dx, dy] = event.get_gesture_motion_delta();
                this._dx += dx;
                this._dy += dy;

                // Once we pass threshold, lock direction and check if continuous
                if (!this._swipeDirectionLocked) {
                    const adx = Math.abs(this._dx);
                    const ady = Math.abs(this._dy);
                    if (Math.max(adx, ady) >= SWIPE_THRESHOLD) {
                        this._swipeDirectionLocked = true;
                        let direction;
                        if (adx >= ady)
                            direction = this._dx > 0 ? 'swipe-right' : 'swipe-left';
                        else
                            direction = this._dy > 0 ? 'swipe-down' : 'swipe-up';

                        const key = `${this._swipePrefix}-${direction}`;
                        const actionType = this._settings.get_int(`${key}-action`);
                        this._swipeKey = key;

                        // Determine if this is a continuous action
                        const isVert = direction === 'swipe-up' || direction === 'swipe-down';
                        if (isVert && actionType === V.VOLUME)
                            this._swipeContinuousAction = 'volume';
                        else if (isVert && actionType === V.BRIGHTNESS)
                            this._swipeContinuousAction = 'brightness';
                        else if (!isVert && (direction === 'swipe-left' || direction === 'swipe-right')) {
                            const isLeft = direction === 'swipe-left';
                            if ((isLeft && actionType === L.BRIGHT_DOWN) ||
                                (!isLeft && actionType === R.BRIGHT_UP))
                                this._swipeContinuousAction = 'brightness';
                        }
                    }
                }

                // For continuous actions, apply delta on every update
                if (this._swipeContinuousAction === 'volume') {
                    this._volumeContinuous(-dy); // negative dy = swipe up = volume up
                    return Clutter.EVENT_STOP;
                }
                if (this._swipeContinuousAction === 'brightness') {
                    // For vertical swipes use -dy (up = brighter)
                    // For horizontal swipes use dx (right = brighter, left = dimmer)
                    const isHorizontal = this._swipeKey?.includes('swipe-left') ||
                        this._swipeKey?.includes('swipe-right');
                    const brightDelta = isHorizontal ? dx : -dy;
                    this._brightnessContinuous(brightDelta);
                    return Clutter.EVENT_STOP;
                }

                return Clutter.EVENT_STOP;
            }

            if (phase === Clutter.TouchpadGesturePhase.END ||
                phase === Clutter.TouchpadGesturePhase.CANCEL) {

                // If it was a continuous action, we already applied it during UPDATE
                if (this._swipeContinuousAction) {
                    this._swipeContinuousAction = null;
                    this._dx = 0;
                    this._dy = 0;
                    return Clutter.EVENT_STOP;
                }

                const adx = Math.abs(this._dx);
                const ady = Math.abs(this._dy);
                const prefix = this._swipePrefix || (n === 4 ? 'four' : 'three');

                if (Math.max(adx, ady) >= SWIPE_THRESHOLD) {
                    let direction;
                    if (adx >= ady) {
                        direction = this._dx > 0 ? 'swipe-right' : 'swipe-left';
                    } else {
                        direction = this._dy > 0 ? 'swipe-down' : 'swipe-up';
                    }
                    const key = `${prefix}-${direction}`;
                    this._idleExec(() => this._executeAction(key));
                } else if (phase === Clutter.TouchpadGesturePhase.END) {
                    // Small swipe (under threshold) might actually be a tap
                    const elapsed = (GLib.get_monotonic_time() - this._swipeStartTime) / 1000;
                    if (elapsed <= TAP_MAX_DURATION_MS) {
                        const key = `${prefix}-tap`;
                        this._idleExec(() => this._executeAction(key));
                    }
                }

                this._dx = 0;
                this._dy = 0;
                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_STOP;
        }

        // ── Touchpad HOLD (tap detection) ─────────────────────────────────────
        if (type === Clutter.EventType.TOUCHPAD_HOLD) {
            const n = event.get_touchpad_gesture_finger_count();
            const phase = event.get_gesture_phase();

            if (n < 3 || n > 4) return Clutter.EVENT_PROPAGATE;

            if (phase === Clutter.TouchpadGesturePhase.BEGIN) {
                this._holdStartTime = GLib.get_monotonic_time();
                this._holdFingers = n;
                return Clutter.EVENT_STOP;
            }

            if (phase === Clutter.TouchpadGesturePhase.END) {
                const elapsed = (GLib.get_monotonic_time() - this._holdStartTime) / 1000;
                const prefix = this._holdFingers === 4 ? 'four' : 'three';

                if (elapsed <= TAP_MAX_DURATION_MS) {
                    const key = `${prefix}-tap`;
                    this._idleExec(() => this._executeAction(key));
                }

                this._holdStartTime = 0;
                this._holdFingers = 0;
                return Clutter.EVENT_STOP;
            }

            if (phase === Clutter.TouchpadGesturePhase.CANCEL) {
                this._holdStartTime = 0;
                this._holdFingers = 0;
                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_STOP;
        }

        // ── Fallback tap detection via Pointer Buttons ────────────────────────
        // libinput translates 3-finger taps to middle click, and sometimes 4-finger to other buttons.
        if (type === Clutter.EventType.BUTTON_RELEASE) {
            const device = event.get_source_device();
            if (device && device.get_device_type() === Clutter.InputDeviceType.TOUCHPAD_DEVICE) {
                const button = event.get_button();
                let key = null;
                if (button === 2) {
                    key = 'three-tap';
                } else if (button === 8 || button === 9) {
                    // Just in case 4-finger tap maps to 8/9
                    key = 'four-tap';
                }

                if (key) {
                    this._idleExec(() => this._executeAction(key));
                    return Clutter.EVENT_STOP;
                }
            }
        }

        return Clutter.EVENT_PROPAGATE;
    }

    // ── Action dispatch ───────────────────────────────────────────────────────

    /**
     * Schedule a callback via GLib.idle_add, tracking the source ID
     * so it can be removed in disable() if still pending.
     */
    _idleExec(fn) {
        const id = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._pendingSources?.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._pendingSources?.add(id);
    }

    _executeAction(key) {
        const actionType = this._settings?.get_int(`${key}-action`);
        if (actionType === undefined || actionType === null) return;

        const isUp = key.endsWith('swipe-up');
        const isDown = key.endsWith('swipe-down');
        const isLeft = key.endsWith('swipe-left');
        const isRight = key.endsWith('swipe-right');
        const isTap = key.endsWith('tap');
        const isVert = isUp || isDown;

        if (isVert) {
            if (actionType < 0 || actionType > MAX_V) return;
            switch (actionType) {
                case V.ACTIVITIES:
                    Main.overview.toggle();
                    break;
                case V.VOLUME:
                    this._volume(isUp);
                    break;
                case V.BRIGHTNESS:
                    this._brightness(isUp);
                    break;
                case V.MAX_MIN: {
                    const w = global.display.get_focus_window();
                    if (!w) break;
                    if (isUp) {
                        // GNOME 50: maximize() takes no args
                        w.maximize();
                    } else {
                        // GNOME 50: is_maximized() replaces get_maximized()
                        if (w.is_maximized())
                            w.unmaximize();
                        else
                            w.minimize();
                    }
                    break;
                }
                case V.CLOSE: {
                    const w = global.display.get_focus_window();
                    if (w) w.delete(global.get_current_time());
                    break;
                }
                case V.SHOW_DESKTOP:
                    this._showDesktop();
                    break;
                case V.CUSTOM:
                    this._fireKeybind(key);
                    break;
                // V.DISABLED: do nothing
            }
            return;
        }

        if (isLeft) {
            if (actionType < 0 || actionType > MAX_L) return;
            switch (actionType) {
                case L.WS_LEFT: this._switchWorkspace(true); break;
                case L.BRIGHT_DOWN: this._brightness(false); break;
                case L.ALTTAB_PREV: this._altTab(false); break;
                case L.MEDIA_PREV: this._media('previous'); break;
                case L.CUSTOM: this._fireKeybind(key); break;
            }
            return;
        }

        if (isRight) {
            if (actionType < 0 || actionType > MAX_R) return;
            switch (actionType) {
                case R.WS_RIGHT: this._switchWorkspace(false); break;
                case R.BRIGHT_UP: this._brightness(true); break;
                case R.ALTTAB_NEXT: this._altTab(true); break;
                case R.MEDIA_NEXT: this._media('next'); break;
                case R.CUSTOM: this._fireKeybind(key); break;
            }
            return;
        }

        if (isTap) {
            if (actionType < 0 || actionType > MAX_T) return;
            switch (actionType) {
                case T.PLAY_PAUSE: this._media('play-pause'); break;
                case T.SHOW_DESKTOP: this._showDesktop(); break;
                case T.CYCLE_WS: this._switchWorkspace(true); break;
                case T.NOTIFS: Main.panel.statusArea.dateMenu?.menu?.toggle(); break;
                case T.CUSTOM: this._fireKeybind(key); break;
            }
        }
    }

    // ── Workspace switching ───────────────────────────────────────────────────

    _switchWorkspace(forward) {
        const wm = global.workspace_manager;
        const cur = wm.get_active_workspace_index();
        const idx = cur + (forward ? 1 : -1);
        if (idx >= 0 && idx < wm.n_workspaces)
            wm.get_workspace_by_index(idx).activate(global.get_current_time());
    }

    // ── Show desktop ──────────────────────────────────────────────────────────

    _showDesktop() {
        const ws = global.workspace_manager.get_active_workspace();
        ws.list_windows()
            .filter(w => !w.is_skip_taskbar() && !w.minimized)
            .forEach(w => w.minimize());
    }

    // ── Media keys simulation ──────────────────────────────────────────────────

    _simulateKey(keyval) {
        if (!this._kb) return;
        const t = Clutter.get_current_event_time();
        this._kb.notify_keyval(t, keyval, Clutter.KeyState.PRESSED);
        this._kb.notify_keyval(t, keyval, Clutter.KeyState.RELEASED);
    }

    // ── Volume control (single step, used by discrete actions) ─────────────

    _volume(isUp) {
        this._volumeContinuous(isUp ? 3 : -3);
    }

    // ── Continuous volume (called per UPDATE event) ────────────────────────

    _volumeContinuous(delta) {
        try {
            if (!this._volumeControl) {
                this._volumeControl =
                    Main.panel?.statusArea?.quickSettings?._volumeOutput?._control ?? null;
            }
            const ctrl = this._volumeControl;
            if (!ctrl) return;

            const stream = ctrl.get_default_sink();
            if (!stream) return;

            const maxVol = ctrl.get_vol_max_norm();
            const cur = stream.volume;
            const step = maxVol * VOL_STEP_PER_PX * Math.abs(delta);
            let newVol = delta > 0 ? cur + step : cur - step;
            newVol = Math.max(0, Math.min(maxVol, newVol));

            stream.volume = newVol;
            stream.push_volume();

            // Throttle OSD to avoid choppiness
            const now = GLib.get_monotonic_time() / 1000;
            if (now - this._lastOsdTime > OSD_THROTTLE_MS) {
                this._lastOsdTime = now;
                const level = newVol / maxVol;
                const icon = level <= 0 ? 'audio-volume-muted-symbolic'
                    : level < 0.33 ? 'audio-volume-low-symbolic'
                        : level < 0.66 ? 'audio-volume-medium-symbolic'
                            : 'audio-volume-high-symbolic';
                // GNOME 50 API: showOne(monitorIndex, icon, label, level, maxLevel)
                Main.osdWindowManager.showOne(
                    Main.layoutManager.primaryIndex,
                    Gio.Icon.new_for_string(icon), null, level,
                );
            }
        } catch (_e) {
            // Volume adjustment failed — ignore silently
        }
    }

    // ── Brightness control (single step, used by discrete actions) ─────────

    _brightness(isUp) {
        try {
            const scale = Main.brightnessManager?.globalScale;
            if (!scale) return;
            if (isUp)
                scale.stepUp();
            else
                scale.stepDown();
        } catch (_e) {
            // Brightness step failed — ignore silently
        }
    }

    // ── Continuous brightness (called per UPDATE event) ────────────────────

    _brightnessContinuous(delta) {
        try {
            const scale = Main.brightnessManager?.globalScale;
            if (!scale) return;

            const step = BRIGHT_STEP_PER_PX * Math.abs(delta);
            let newVal = delta > 0 ? scale.value + step : scale.value - step;
            newVal = Math.max(0, Math.min(1.0, newVal));
            scale.value = newVal;

            // OSD is handled by BrightnessManager itself via _showOSD(),
            // but we throttle an extra OSD call here for visual feedback
            // in case the internal one doesn't trigger.
            const now = GLib.get_monotonic_time() / 1000;
            if (now - this._lastOsdTime > OSD_THROTTLE_MS) {
                this._lastOsdTime = now;
                // GNOME 50 API: showOne(monitorIndex, icon, label, level, maxLevel)
                Main.osdWindowManager.showOne(
                    Main.layoutManager.primaryIndex,
                    Gio.Icon.new_for_string('display-brightness-symbolic'),
                    null, newVal,
                );
            }
        } catch (_e) {
            // Brightness continuous adjustment failed — ignore silently
        }
    }

    // ── Media control via MPRIS D-Bus ─────────────────────────────────────

    _media(cmd) {
        let method;
        if (cmd === 'play-pause') method = 'PlayPause';
        else if (cmd === 'next') method = 'Next';
        else if (cmd === 'previous') method = 'Previous';
        if (!method) return;

        if (cmd !== 'play-pause') {
            this._simulateMediaKey(cmd);
            return;
        }

        // For play-pause: use MPRIS D-Bus only (no key simulation)
        Gio.DBus.session.call(
            'org.freedesktop.DBus',
            '/org/freedesktop/DBus',
            'org.freedesktop.DBus',
            'ListNames',
            null,
            new GLib.VariantType('(as)'),
            Gio.DBusCallFlags.NONE, -1, null,
            (conn, res) => {
                try {
                    const result = conn.call_finish(res);
                    const names = result.get_child_value(0).deepUnpack();
                    const mprisNames = names.filter(n => n.startsWith('org.mpris.MediaPlayer2.'));

                    if (mprisNames.length === 0) {
                        this._simulateMediaKey(cmd);
                        return;
                    }

                    this._tryMprisPlayers(mprisNames, 0, method, cmd);
                } catch (_e) {
                    this._simulateMediaKey(cmd);
                }
            }
        );
    }

    _tryMprisPlayers(players, idx, method, cmd) {
        if (idx >= players.length) return;
        const busName = players[idx];
        Gio.DBus.session.call(
            busName,
            '/org/mpris/MediaPlayer2',
            MPRIS_PLAYER_IFACE,
            method,
            null,
            null,
            Gio.DBusCallFlags.NONE, -1, null,
            (conn, res) => {
                try {
                    conn.call_finish(res);
                } catch (_e) {
                    this._tryMprisPlayers(players, idx + 1, method, cmd);
                }
            }
        );
    }

    _simulateMediaKey(cmd) {
        let keyval;
        if (cmd === 'play-pause') keyval = Clutter.KEY_AudioPlay;
        else if (cmd === 'next') keyval = Clutter.KEY_AudioNext;
        else if (cmd === 'previous') keyval = Clutter.KEY_AudioPrev;
        if (keyval) this._simulateKey(keyval);
    }

    // ── Alt+Tab simulation ────────────────────────────────────────────────────

    _altTab(forward) {
        const t = Clutter.get_current_event_time();
        this._kb.notify_keyval(t, Clutter.KEY_Alt_L, Clutter.KeyState.PRESSED);
        if (!forward)
            this._kb.notify_keyval(t, Clutter.KEY_Shift_L, Clutter.KeyState.PRESSED);
        this._kb.notify_keyval(t, Clutter.KEY_Tab, Clutter.KeyState.PRESSED);
        this._kb.notify_keyval(t, Clutter.KEY_Tab, Clutter.KeyState.RELEASED);
        if (!forward)
            this._kb.notify_keyval(t, Clutter.KEY_Shift_L, Clutter.KeyState.RELEASED);
        this._kb.notify_keyval(t, Clutter.KEY_Alt_L, Clutter.KeyState.RELEASED);
    }

    // ── Custom keybind firing ─────────────────────────────────────────────────

    _fireKeybind(gestureKey) {
        const stored = this._settings?.get_string(`${gestureKey}-keybind`);
        if (!stored || !stored.includes(':')) return;

        const parts = stored.split(':');
        const keyval = parseInt(parts[0], 10);
        const mods = parseInt(parts[1], 10);
        if (!keyval) return;



        const kb = this._kb;

        // Gdk.ModifierType bitmask values (GTK4)
        const GDK_SHIFT_MASK = 1;
        const GDK_LOCK_MASK = 2;
        const GDK_CONTROL_MASK = 4;
        const GDK_ALT_MASK = 8;
        const GDK_SUPER_MASK = 67108864;
        const GDK_HYPER_MASK = 134217728;
        const GDK_META_MASK = 268435456;

        let t = global.get_current_time();
        if (!t) t = GLib.get_monotonic_time() / 1000;

        // Press modifier keys first
        if (mods & GDK_SHIFT_MASK) kb.notify_keyval(t, Clutter.KEY_Shift_L, Clutter.KeyState.PRESSED);
        if (mods & GDK_CONTROL_MASK) kb.notify_keyval(t, Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
        if (mods & GDK_ALT_MASK) kb.notify_keyval(t, Clutter.KEY_Alt_L, Clutter.KeyState.PRESSED);
        if (mods & GDK_SUPER_MASK) kb.notify_keyval(t, Clutter.KEY_Super_L, Clutter.KeyState.PRESSED);
        if (mods & GDK_HYPER_MASK) kb.notify_keyval(t, Clutter.KEY_Hyper_L, Clutter.KeyState.PRESSED);
        if (mods & GDK_META_MASK) kb.notify_keyval(t, Clutter.KEY_Meta_L, Clutter.KeyState.PRESSED);

        // Press and release the main key
        t += 1;
        kb.notify_keyval(t, keyval, Clutter.KeyState.PRESSED);
        t += 1;
        kb.notify_keyval(t, keyval, Clutter.KeyState.RELEASED);

        // Release modifier keys (reverse order)
        t += 1;
        if (mods & GDK_META_MASK) kb.notify_keyval(t, Clutter.KEY_Meta_L, Clutter.KeyState.RELEASED);
        if (mods & GDK_HYPER_MASK) kb.notify_keyval(t, Clutter.KEY_Hyper_L, Clutter.KeyState.RELEASED);
        if (mods & GDK_SUPER_MASK) kb.notify_keyval(t, Clutter.KEY_Super_L, Clutter.KeyState.RELEASED);
        if (mods & GDK_ALT_MASK) kb.notify_keyval(t, Clutter.KEY_Alt_L, Clutter.KeyState.RELEASED);
        if (mods & GDK_CONTROL_MASK) kb.notify_keyval(t, Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);
        if (mods & GDK_SHIFT_MASK) kb.notify_keyval(t, Clutter.KEY_Shift_L, Clutter.KeyState.RELEASED);
    }
}
