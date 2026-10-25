// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    HOME_REQUEST_KEY, MAX_WORKSPACES, RULES_KEY, RULES_TYPE,
    compileRule, normalizeAppId, packRules, unpackRules,
} from './common.js';

// A title, or a workspace number held on + or −, is saved once it stops
// changing: the extension would otherwise apply every step as a rule.
const SAVE_DELAY_MS = 500;

const MATCH_CHOICES = [
    ['any', 'Any window'],
    ['is', 'Title is'],
    ['contains', 'Title contains'],
    ['matches', 'Title matches regex'],
];

const STYLE = `
.homing-badge {
    min-width: 32px;
    min-height: 28px;
    border-radius: 8px;
    font-weight: bold;
    background-color: @accent_bg_color;
    color: @accent_fg_color;
}
.homing-badge.missing {
    background-color: transparent;
    border: 1px dashed alpha(currentColor, 0.4);
    color: alpha(currentColor, 0.6);
}
`;

const AppItem = GObject.registerClass({
    Properties: {
        'app-id': GObject.ParamSpec.string('app-id', 'App ID', 'Desktop file id',
            GObject.ParamFlags.READWRITE, ''),
        'name': GObject.ParamSpec.string('name', 'Name', 'Name shown in the list',
            GObject.ParamFlags.READWRITE, ''),
        'gicon': GObject.ParamSpec.object('gicon', 'Icon', 'Application icon',
            GObject.ParamFlags.READWRITE, Gio.Icon.$gtype),
    },
}, class AppItem extends GObject.Object {});

function getUnknownIcon() {
    return Gio.ThemedIcon.new('application-x-executable');
}

function describeRule(rule) {
    if (!rule.app)
        return 'Choose an application';
    const {problem} = compileRule(rule);
    if (problem)
        return `Not active: ${problem}`;
    switch (rule.match) {
    case 'is':
        return `Window titled “${rule.text}”`;
    case 'contains':
        return `Title contains “${rule.text}”`;
    case 'matches':
        return `Title matches regex /${rule.text}/`;
    default:
        return 'Any window';
    }
}

export default class WindowHomingPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._settings = this.getSettings();
        this._wmSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});
        this._mutterSettings = new Gio.Settings({schema_id: 'org.gnome.mutter'});
        this._rows = [];

        const styleProvider = new Gtk.CssProvider();
        styleProvider.load_from_string(STYLE);
        const display = Gdk.Display.get_default();
        Gtk.StyleContext.add_provider_for_display(display, styleProvider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

        this._apps = this._listApps();
        this._appFactory = this._createAppFactory();

        window.set_default_size(600, 640);
        const page = new Adw.PreferencesPage();
        window.add(page);

        this._group = new Adw.PreferencesGroup({
            title: 'Rules',
            description: 'When a window opens, it goes to the workspace of the rule that ' +
                'matches its application and title. In Chrome, “Name window…” in the tab ' +
                'strip menu gives a window a title of its own.',
        });
        page.add(this._group);

        const addButton = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            tooltip_text: 'Add a rule',
            valign: Gtk.Align.CENTER,
        });
        addButton.connect('clicked', () => this._addRule());
        this._group.set_header_suffix(addButton);

        this._emptyRow = new Adw.ActionRow({
            title: 'No rules yet',
            subtitle: 'Add one with the + button',
            activatable: false,
        });
        this._group.add(this._emptyRow);

        const homeGroup = new Adw.PreferencesGroup();
        const homeButton = new Gtk.Button({label: 'Send Home', valign: Gtk.Align.CENTER});
        const homeRow = new Adw.ActionRow({
            title: 'Send Open Windows Home',
            subtitle: 'Rules apply to windows as they open: this applies them now to every ' +
                'open window, wherever it is',
            activatable_widget: homeButton,
        });
        homeRow.add_suffix(homeButton);
        homeGroup.add(homeRow);
        page.add(homeGroup);
        homeButton.connect('clicked', () => {
            // An edit still waiting to be saved belongs to the rules sent home.
            this._flushSave();
            this._settings.set_int64(HOME_REQUEST_KEY, GLib.get_real_time());
        });

        // The window stays in sync with changes made elsewhere, e.g. gsettings.
        const refreshRows = () => this._rows.forEach(row => this._updateRow(row));
        const handlers = [
            [this._settings, this._settings.connect(`changed::${RULES_KEY}`, () => this._load())],
            [this._wmSettings, this._wmSettings.connect('changed::num-workspaces', refreshRows)],
            [this._mutterSettings, this._mutterSettings.connect('changed::dynamic-workspaces', refreshRows)],
        ];
        // The shell keeps this object after the window closes: whatever it
        // still holds could not be freed.
        window.connect('close-request', () => {
            this._flushSave();
            handlers.forEach(([settings, id]) => settings.disconnect(id));
            Gtk.StyleContext.remove_provider_for_display(display, styleProvider);
            this._settings = this._wmSettings = this._mutterSettings = null;
            this._group = this._emptyRow = this._rows = null;
            this._apps = this._appFactory = null;
            return false;
        });

        this._load();
    }

    // Installed applications by name, after a "choose" entry for new rules.
    _listApps() {
        const store = new Gio.ListStore({item_type: AppItem});
        store.append(new AppItem({app_id: '', name: 'Choose an application', gicon: getUnknownIcon()}));
        Gio.AppInfo.get_all()
            .filter(info => info.should_show())
            .map(info => new AppItem({
                app_id: info.get_id(),
                name: info.get_display_name(),
                gicon: info.get_icon() ?? getUnknownIcon(),
            }))
            .sort((a, b) => a.name.localeCompare(b.name))
            .forEach(item => store.append(item));
        return store;
    }

    // Position of the application in the list. A rule written with gsettings
    // may name an application hidden from the menu, a window class or an
    // application that is not installed: it gets an entry of its own.
    _findApp(appId) {
        const id = normalizeAppId(appId);
        for (let i = 0; i < this._apps.get_n_items(); i++) {
            if (normalizeAppId(this._apps.get_item(i).app_id) === id)
                return i;
        }
        const info = Gio.DesktopAppInfo.new(appId.endsWith('.desktop') ? appId : `${appId}.desktop`);
        this._apps.append(new AppItem({
            app_id: appId,
            name: info?.get_display_name() ?? appId,
            gicon: info?.get_icon() ?? getUnknownIcon(),
        }));
        return this._apps.get_n_items() - 1;
    }

    _createAppFactory() {
        const factory = new Gtk.SignalListItemFactory();
        factory.connect('setup', (_factory, listItem) => {
            const box = new Gtk.Box({spacing: 8});
            box.append(new Gtk.Image());
            box.append(new Gtk.Label({xalign: 0, ellipsize: Pango.EllipsizeMode.END}));
            listItem.set_child(box);
        });
        factory.connect('bind', (_factory, listItem) => {
            const box = listItem.get_child();
            const app = listItem.get_item();
            box.get_first_child().gicon = app.gicon;
            box.get_last_child().label = app.name;
        });
        return factory;
    }

    _getShownRules() {
        return new GLib.Variant(RULES_TYPE, packRules(this._rows.map(({rule}) => rule)));
    }

    // Rebuilds the rows from the settings when they show something else. The
    // window's own saves change nothing shown: rebuilding then would steal
    // the focus while typing.
    _load() {
        const value = this._settings.get_value(RULES_KEY);
        if (value.equal(this._getShownRules()))
            return;
        this._cancelSave();
        for (const {row} of this._rows)
            this._group.remove(row);
        this._rows = unpackRules(value).map(rule => this._createRow(rule));
        this._emptyRow.visible = this._rows.length === 0;
    }

    _save() {
        this._cancelSave();
        this._emptyRow.visible = this._rows.length === 0;
        this._settings.set_value(RULES_KEY, this._getShownRules());
    }

    _flushSave() {
        if (this._saveId)
            this._save();
    }

    _saveSoon() {
        this._cancelSave();
        this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DELAY_MS, () => {
            this._saveId = 0;
            this._save();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelSave() {
        if (this._saveId)
            GLib.source_remove(this._saveId);
        this._saveId = 0;
    }

    _addRule() {
        const entry = this._createRow({app: '', match: 'any', text: '', workspace: 1});
        this._rows.push(entry);
        this._save();
        // Focusing its first field also scrolls the new rule into view.
        entry.row.expanded = true;
        entry.appRow.grab_focus();
    }

    _removeRow(entry) {
        this._rows.splice(this._rows.indexOf(entry), 1);
        this._group.remove(entry.row);
        this._save();
    }

    _createRow(rule) {
        const row = new Adw.ExpanderRow({use_markup: false});
        const icon = new Gtk.Image({pixel_size: 32});
        row.add_prefix(icon);
        const warning = new Gtk.Image({
            icon_name: 'dialog-warning-symbolic',
            css_classes: ['warning'],
        });
        const badge = new Gtk.Label({
            valign: Gtk.Align.CENTER,
            css_classes: ['homing-badge'],
        });
        // In an expander row add_suffix() puts each widget before the previous
        // ones: the badge, added first, stays in line with the other rows'.
        row.add_suffix(badge);
        row.add_suffix(warning);

        const appRow = new Adw.ComboRow({
            title: 'Application',
            model: this._apps,
            expression: Gtk.PropertyExpression.new(AppItem, null, 'name'),
            enable_search: true,
            factory: this._appFactory,
            selected: this._findApp(rule.app),
        });
        // "code" finds Visual Studio Code. Before libadwaita 1.6 the search
        // only matches the start of the name.
        if ('search_match_mode' in appRow)
            appRow.search_match_mode = Gtk.StringFilterMatchMode.SUBSTRING;
        // A match unknown to this window, written with gsettings, gets an
        // entry of its own and stays as it is until a real one is picked.
        const matchLabels = MATCH_CHOICES.map(([, label]) => label);
        let matchPosition = MATCH_CHOICES.findIndex(([match]) => match === rule.match);
        if (matchPosition < 0)
            matchPosition = matchLabels.push(`Unknown: “${rule.match}”`) - 1;
        const matchRow = new Adw.ComboRow({
            title: 'Window',
            model: Gtk.StringList.new(matchLabels),
            selected: matchPosition,
        });
        const textRow = new Adw.EntryRow({title: 'Title', text: rule.text});
        const workspaceRow = Adw.SpinRow.new_with_range(1, MAX_WORKSPACES, 1);
        workspaceRow.title = 'Workspace';
        workspaceRow.value = rule.workspace;
        const removeButton = new Gtk.Button({
            label: 'Remove',
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        const removeRow = new Adw.ActionRow({
            title: 'Remove Rule',
            activatable_widget: removeButton,
        });
        removeRow.add_suffix(removeButton);
        [appRow, matchRow, textRow, workspaceRow, removeRow].forEach(r => row.add_row(r));

        const entry = {row, rule, icon, warning, badge, appRow, textRow, workspaceRow};
        const update = () => {
            this._save();
            this._updateRow(entry);
        };
        appRow.connect('notify::selected', () => {
            rule.app = appRow.selected_item.app_id;
            update();
        });
        matchRow.connect('notify::selected', () => {
            const choice = MATCH_CHOICES[matchRow.selected];
            if (choice) {
                rule.match = choice[0];
                update();
            }
        });
        textRow.connect('changed', () => {
            rule.text = textRow.text;
            this._updateRow(entry);
            this._saveSoon();
        });
        workspaceRow.connect('notify::value', () => {
            rule.workspace = Math.round(workspaceRow.value);
            this._updateRow(entry);
            this._saveSoon();
        });
        removeButton.connect('clicked', () => this._removeRow(entry));

        this._group.add(row);
        this._updateRow(entry);
        return entry;
    }

    _updateRow({row, rule, icon, warning, badge, appRow, textRow, workspaceRow}) {
        const app = appRow.selected_item;
        row.title = rule.app ? app.name : 'New Rule';
        row.subtitle = describeRule(rule);
        icon.gicon = app.gicon;
        textRow.visible = rule.match !== 'any';
        textRow.title = rule.match === 'matches' ? 'Regular expression' : 'Title';

        // Dynamic workspaces are created when a window needs one; fixed ones
        // beyond the count do not exist, and the window stays where it opens.
        const count = this._wmSettings.get_int('num-workspaces');
        const missing = !this._mutterSettings.get_boolean('dynamic-workspaces') &&
            rule.workspace > count;
        badge.label = `${rule.workspace}`;
        badge.tooltip_text = `Workspace ${rule.workspace}`;
        if (missing)
            badge.add_css_class('missing');
        else
            badge.remove_css_class('missing');
        warning.visible = missing;
        warning.tooltip_text = `There are only ${count} workspaces`;
        workspaceRow.subtitle = missing
            ? `There are only ${count}: windows stay where they open`
            : '';
    }
}
