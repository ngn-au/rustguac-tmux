#!/usr/bin/env node
/*
 * Pins the Mac editing keys for SSH terminals: what
 * rgTermKeyAction sends for Cmd/Option + Left/Right/Backspace, which held
 * modifier it lifts, and that everything else is left to the terminal.
 *
 * Usage: node tests/client-mac-keys.mjs
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

const act = lift('rgTermKeyAction');
const k = (key, mods = {}) => act({ key, metaKey: false, altKey: false, ctrlKey: false, shiftKey: false, ...mods });
const plain = (a) => a && JSON.parse(JSON.stringify(a));
const CTRL = 0xFFE3;

const ESC = 0xFF1B, RETURN = 0xFF0D;
// Cmd: line start/end and delete to line start, with Cmd lifted.
assert.deepEqual(plain(k('ArrowLeft', { metaKey: true })), { lift: 'meta', keys: [[CTRL, 0x61]] });
assert.deepEqual(plain(k('ArrowRight', { metaKey: true })), { lift: 'meta', keys: [[CTRL, 0x65]] });
assert.deepEqual(plain(k('Backspace', { metaKey: true })), { lift: 'meta', keys: [[CTRL, 0x75]] });
// Option: an explicit Esc then b/f (Option reaches guacd as AltGr, which is
// not Alt to it), with Option lifted; delete word as Ctrl-W.
assert.deepEqual(plain(k('ArrowLeft', { altKey: true })), { lift: 'alt', keys: [[ESC], [0x62]] });
assert.deepEqual(plain(k('ArrowRight', { altKey: true })), { lift: 'alt', keys: [[ESC], [0x66]] });
assert.deepEqual(plain(k('Backspace', { altKey: true })), { lift: 'alt', keys: [[CTRL, 0x77]] });
// Shift+Enter: Esc Return, Claude Code's new line, with Shift lifted.
assert.deepEqual(plain(k('Enter', { shiftKey: true })), { lift: 'shift', keys: [[ESC], [RETURN]] });
// Left alone: no modifier, Shift (selection/scrollback), Ctrl, Cmd+Option,
// other keys, Cmd+V (pasted directly elsewhere) and plain Enter.
for (const [key, mods] of [
    ['ArrowLeft', {}],
    ['ArrowLeft', { metaKey: true, shiftKey: true }],
    ['ArrowLeft', { altKey: true, shiftKey: true }],
    ['ArrowLeft', { ctrlKey: true }],
    ['ArrowLeft', { metaKey: true, altKey: true }],
    ['ArrowUp', { metaKey: true }],
    ['v', { metaKey: true }],
    ['a', { altKey: true }],
    ['Enter', {}],
    ['Enter', { shiftKey: true, metaKey: true }],
]) {
    assert.equal(k(key, mods), null, `${key} ${JSON.stringify(mods)}`);
}

// Cmd+V in a terminal goes to the direct paste, and the old Ctrl/Cmd+V
// handler steps aside for it.
assert.ok(html.includes('if (macKeys && terminalSession && (e.metaKey || e.ctrlKey)) return;'), 'the old Ctrl/Cmd+V handler steps aside');
assert.match(html, /client\.createPipeStream\('text\/plain', 'STDIN'\)/);
assert.match(html, /'\\x1b\[200~' \+ text \+ '\\x1b\[201~'/);

// The handler is only for SSH sessions and gated on the toggle.
assert.match(html, /if \(!macKeys \|\| !terminalSession \|\| panelOpen \|\| !client\) return;/);
assert.match(html, /terminalSession = !!\(session && session\.session_type === 'ssh'\);/);
console.log('client-mac-keys: ok');

// Images and files. A Cmd+V with an image and no text, Ctrl+V with an
// image on the clipboard, and a drop all go to rgSendFiles, which saves each
// file on the host (POST .../upload) and pastes the saved paths.
const name = lift('rgFileName');
assert.equal(name({ name: 'Screen Shot.png', type: 'image/png' }, 0), 'Screen Shot.png');
assert.match(name({ type: 'image/jpeg' }, 0), /^pasted-\d{8}-\d{6}\.jpg$/);
assert.match(name({ name: 'image.png', type: 'image/png' }, 2), /^pasted-\d{8}-\d{6}-2\.png$/);
assert.match(html, /if \(!text && files\.length\) \{ rgSendFiles\(files\); return; \}/);
assert.match(html, /navigator\.clipboard\.read\(\)/);
assert.match(html, /'\/upload\?name=' \+ encodeURIComponent\(name\)/);
assert.match(html, /rgPasteText\(paths\.join\(' '\) \+ ' '\)/);
console.log('client-mac-keys: ok');
