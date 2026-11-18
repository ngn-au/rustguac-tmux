#!/usr/bin/env node
/*
 * Pins when an embedded client (the tmux workspace's frames) lets its
 * display take the focus on the workspace's request: after a tab switch the
 * display has lost it and must get it back, or typing goes nowhere until a
 * click. A field the user is in, in a panel still showing, keeps it.
 *
 * Usage: node tests/client-embedded-focus.mjs
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = await readFile(join(root, 'static/client.html'), 'utf8');

function lift(name) {
    const start = html.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name}() must exist in client.html`);
    let i = html.indexOf('{', start), depth = 0;
    for (; i < html.length; i++) {
        if (html[i] === '{') depth++;
        else if (html[i] === '}' && --depth === 0) break;
    }
    const ctx = {};
    vm.runInNewContext(html.slice(start, i + 1) + `; this.${name} = ${name};`, ctx);
    return ctx[name];
}

const shouldTake = lift('rgDisplayShouldTakeFocus');
const body = { offsetParent: null }, display = { offsetParent: {} };
const shown = { offsetParent: {} }, hidden = { offsetParent: null };

assert.equal(shouldTake(null, body, display), true, 'nothing focused');
assert.equal(shouldTake(body, body, display), true, 'focus fell back to the body (the pane was hidden)');
assert.equal(shouldTake(display, body, display), true, 'the display already');
assert.equal(shouldTake(hidden, body, display), true, 'a field in a panel that is no longer showing');
assert.equal(shouldTake(shown, body, display), false, 'a field the user is in keeps the focus');

// The workspace's request is what triggers it, and only when embedded.
assert.match(html, /rgLauncher !== 'focus'\) return;\s*if \(!rgDisplayShouldTakeFocus\(/, 'the focus request is handled');
assert.match(html, /if \(embedded\) \{\s*window\.addEventListener\('message', function\(e\) \{\s*if \(e\.origin !== location\.origin \|\| !e\.data \|\| e\.data\.rgLauncher !== 'focus'\)/, 'only when embedded, only from the same origin');
// Embedded, the display never takes the focus by itself: a tab connecting
// in the background would take the keyboard from the tab being typed in.
assert.match(html, /if \(!embedded\) displayEl\.focus\(\);\s*var keyboard = new Guacamole\.Keyboard\(displayEl\);/, 'no focus of its own when embedded');
const tmux = await readFile(join(root, 'static/tmux.html'), 'utf8');
assert.match(tmux, /postMessage\(\{ rgLauncher: 'focus' \}, location\.origin\)/, 'the workspace asks for it');

console.log('client-embedded-focus: ok');
