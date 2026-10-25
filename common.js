// SPDX-License-Identifier: GPL-2.0-or-later

// Shared by the extension (in the shell) and the settings window (GTK).

export const RULES_KEY = 'rules';
export const HOME_REQUEST_KEY = 'home-request';

export const RULES_TYPE = 'a(sssi)';

// Match kinds, from the least to the most specific: when several rules match
// a window, the most specific one wins. 'matches' is a regular expression.
export const MATCHES = ['any', 'contains', 'matches', 'is'];

// The most workspaces mutter accepts.
export const MAX_WORKSPACES = 36;

// Rule fields as stored in GSettings, in tuple order.
export function unpackRules(variant) {
    return variant.deepUnpack().map(([app, match, text, workspace]) => ({app, match, text, workspace}));
}

export function packRules(rules) {
    return rules.map(({app, match, text, workspace}) => [app, match, text, workspace]);
}

// A rule as a test of the window title, {test}, or the reason the extension
// skips it, {problem}. A rule with a typo in its match must not widen to
// every window of the application, and a title rule still waiting for its
// text would catch them all too. Titles are compared ignoring case.
export function compileRule({app, match, text, workspace}) {
    if (!app)
        return {problem: 'no application'};
    if (!MATCHES.includes(match))
        return {problem: `unknown match “${match}”`};
    if (match !== 'any' && !text)
        return {problem: 'write the title to match'};
    if (workspace < 1 || workspace > MAX_WORKSPACES)
        return {problem: `workspace ${workspace} is not between 1 and ${MAX_WORKSPACES}`};

    const lowerText = text.toLowerCase();
    switch (match) {
    case 'is':
        return {test: title => title.toLowerCase() === lowerText};
    case 'contains':
        return {test: title => title.toLowerCase().includes(lowerText)};
    case 'matches':
        try {
            // Unicode mode, so that \p{Lu} means an uppercase letter and not
            // the text "p{Lu}".
            const regex = new RegExp(text, 'iu');
            return {test: title => regex.test(title)};
        } catch {
            return {problem: 'not a valid regular expression'};
        }
    default:
        return {test: () => true};
    }
}

// Desktop file ids and window classes name the same application in different
// ways: "google-chrome.desktop", "google-chrome", "Google-chrome".
export function normalizeAppId(id) {
    return id.toLowerCase().replace(/\.desktop$/, '');
}
