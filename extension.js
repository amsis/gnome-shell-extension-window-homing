// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    HOME_REQUEST_KEY, MATCHES, RULES_KEY, compileRule, normalizeAppId, unpackRules,
} from './common.js';

// A new window often gets its final title a little later: a browser restoring
// its session, an editor opening a project. Until then, title changes are
// checked again; after this long the window is left alone.
const SETTLE_SECONDS = 20;

// The application the window belongs to. When the shell matched it to a
// desktop file, that is the only name: web apps installed from Chrome share
// Chrome's window class on X11 but are applications of their own. Otherwise
// the window's own names: its class and its Wayland app id.
function getAppIds(window) {
    const app = Shell.WindowTracker.get_default().get_window_app(window);
    const ids = app && !app.is_window_backed()
        ? [app.get_id()]
        : [
            window.get_wm_class(),
            window.get_wm_class_instance(),
            window.get_sandboxed_app_id(),
            window.get_gtk_application_id(),
        ];
    return ids.filter(id => id).map(normalizeAppId);
}

// Dialogs follow their parent, and windows on every workspace or hidden from
// the taskbar (docks, desktop icons) have no workspace to go to. On Wayland a
// window is created before the client says anything about it, so it is left
// alone until it has a class: by then a dialog has its parent too, while the
// shell may already know the application from the process and would match it.
function canMove(window) {
    return !!window.get_wm_class() &&
        window.get_window_type() === Meta.WindowType.NORMAL &&
        !window.get_transient_for() &&
        !window.skip_taskbar &&
        !window.is_on_all_workspaces();
}

export default class WindowHomingExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._settings.connectObject(
            `changed::${RULES_KEY}`, () => this._loadRules(),
            `changed::${HOME_REQUEST_KEY}`, () => {
                const request = this._settings.get_int64(HOME_REQUEST_KEY);
                if (request !== this._homeRequest) {
                    this._homeRequest = request;
                    this._sendAllHome();
                }
            },
            this);
        // GSettings also reports a key as changed when it is written with the
        // same value, e.g. when a dconf backup is loaded: only a new request
        // sends the windows home. Reading the key also makes GSettings report
        // its changes.
        this._homeRequest = this._settings.get_int64(HOME_REQUEST_KEY);
        this._loadRules();

        // Window -> settle timeout of the windows still being watched.
        this._waiting = new Map();
        global.display.connectObject('window-created',
            (display, window) => this._watch(window), this);

        // At login the extension starts before any window opens. Enabled at
        // any other time, e.g. when the screen unlocks, it leaves the open
        // windows where they are: the user may have moved them.
        if (Main.layoutManager._startingUp)
            global.display.list_all_windows().forEach(window => this._watch(window));
    }

    disable() {
        for (const window of this._waiting.keys())
            this._unwatch(window);
        this._waiting = null;
        global.display.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._settings = null;
        this._rules = null;
    }

    _loadRules() {
        // Most specific first; sort() is stable, so equals keep list order.
        this._rules = unpackRules(this._settings.get_value(RULES_KEY))
            .map(rule => ({...rule, ...compileRule(rule), app: normalizeAppId(rule.app)}))
            .filter(rule => rule.test)
            .sort((a, b) => MATCHES.indexOf(b.match) - MATCHES.indexOf(a.match));
    }

    _findRule(window) {
        const ids = getAppIds(window);
        const title = window.get_title() ?? '';
        return this._rules.find(rule => ids.includes(rule.app) && rule.test(title));
    }

    // Moves the window to the workspace of the best rule that matches it, and
    // returns that rule.
    _sendHome(window) {
        if (!canMove(window))
            return null;
        const rule = this._findRule(window);
        if (!rule)
            return null;

        const index = rule.workspace - 1;
        const workspaceManager = global.workspace_manager;
        const dynamic = Meta.prefs_get_dynamic_workspaces();
        if (!dynamic && index >= workspaceManager.n_workspaces)
            return null;
        // Dynamic workspaces are created on demand. The shell removes empty
        // ones, so those left empty in between are kept for the settle time:
        // the windows meant for them, opening at login, can still fill them.
        while (dynamic && workspaceManager.n_workspaces <= index) {
            Main.wm.keepWorkspaceAlive(
                workspaceManager.get_workspace_by_index(workspaceManager.n_workspaces - 1),
                SETTLE_SECONDS * 1000);
            workspaceManager.append_new_workspace(false, global.get_current_time());
        }
        if (window.get_workspace().index() !== index) {
            // Moves made here must not look like the user moving the window.
            this._moving = true;
            try {
                window.change_workspace_by_index(index, false);
            } finally {
                this._moving = false;
            }
        }
        return rule;
    }

    // Applies the rules now and, unless a title matched exactly, again on
    // every title change for a while: a window restored with a provisional
    // title may first match a broader rule than the one meant for it.
    _watch(window) {
        // Menus, tooltips and other popups never become normal windows.
        if (this._waiting.has(window) || !this._rules.length ||
            window.get_window_type() !== Meta.WindowType.NORMAL)
            return;

        const check = () => {
            if (this._sendHome(window)?.match === 'is')
                this._unwatch(window);
        };
        // A window is created on a workspace already: any change not made
        // here is the user moving it, and ends the watch.
        window.connectObject(
            'notify::title', check,
            'notify::wm-class', check,
            // The shell may also match the window to an application only when
            // its GTK application id arrives.
            'notify::gtk-application-id', check,
            'workspace-changed', () => {
                if (!this._moving)
                    this._unwatch(window);
            },
            'unmanaged', () => this._unwatch(window),
            this);
        this._waiting.set(window, GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, SETTLE_SECONDS, () => {
            this._unwatch(window);
            return GLib.SOURCE_REMOVE;
        }));
        check();
    }

    _unwatch(window) {
        const timeoutId = this._waiting.get(window);
        if (timeoutId === undefined)
            return;
        GLib.source_remove(timeoutId);
        this._waiting.delete(window);
        window.disconnectObject(this);
    }

    // Asked for by the settings window: every open window, wherever it is now.
    // A window still waiting for its title stays watched: the title it gets
    // may be meant for another rule.
    _sendAllHome() {
        for (const window of global.display.list_all_windows())
            this._sendHome(window);
    }
}
