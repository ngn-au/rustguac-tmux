#!/usr/bin/env node
/*
 * Pins how a session's tunnel behaves while its tab is hidden (#331).
 *
 * The tunnel closes itself after 15 seconds without a message. In a
 * background tab (throttled timers; Safari freezes it) that timeout could
 * run, when the page thawed, before the messages that had arrived were read,
 * closing a live session. While hidden it is held off; back in view, a
 * session that hears nothing for the usual 15 seconds is still closed.
 *
 * Usage: node tests/client-hidden-tunnel.mjs
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = await readFile(join(root, 'static/client.html'), 'utf8');

function source(name) {
    const start = html.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name}() must exist in client.html`);
    let i = html.indexOf('{', start), depth = 0;
    for (; i < html.length; i++) {
        if (html[i] === '{') depth++;
        else if (html[i] === '}' && --depth === 0) break;
    }
    return html.slice(start, i + 1);
}
const constant = html.match(/var RG_HIDDEN_RECEIVE_TIMEOUT = [^;]+;/);
assert.ok(constant, 'RG_HIDDEN_RECEIVE_TIMEOUT must exist');

function setup(hidden) {
    let now = 1_000_000;
    const timers = [];
    const ctx = {
        Date: { now: () => now },
        Guacamole: { Tunnel: { State: { OPEN: 1, CLOSED: 2 } } }
    };
    vm.runInNewContext(constant[0] + source('rgKeepTunnelWhileHidden') + '; this.keep = rgKeepTunnelWhileHidden;', ctx);
    const seen = [];
    const tunnel = {
        receiveTimeout: 15000, state: 1, closed: 0,
        oninstruction: (op) => seen.push(op),
        disconnect() { this.closed++; this.state = 2; }
    };
    const listeners = {};
    const doc = { hidden, addEventListener: (t, f) => { listeners[t] = f; } };
    const win = { setTimeout: (f, ms) => timers.push({ at: now + ms, f }) };
    ctx.keep(tunnel, doc, win);
    return {
        tunnel, doc, seen,
        set hidden(v) { doc.hidden = v; listeners.visibilitychange(); },
        message(op = 'nop') { tunnel.oninstruction(op); },
        advance(ms) {
            now += ms;
            for (const t of timers.splice(0)) { if (t.at <= now) t.f(); else timers.push(t); }
        }
    };
}

// Visible: nothing changes.
let s = setup(false);
assert.equal(s.tunnel.receiveTimeout, 15000);
s.message('sync');
assert.deepEqual(s.seen, ['sync'], 'instructions still reach the client');

// Hidden: the timeout is held off.
s.hidden = true;
assert.ok(s.tunnel.receiveTimeout >= 3600 * 1000, 'held off while hidden');

// Shown again, and guacd's keepalive arrives: the session stays.
s.hidden = false;
assert.equal(s.tunnel.receiveTimeout, 15000, 'the usual timeout once visible');
s.advance(4000);
s.message();
s.advance(20000);
assert.equal(s.tunnel.closed, 0, 'a session that is heard from stays open');

// Shown again, and nothing at all arrives: closed after the usual timeout.
s = setup(false);
s.hidden = true;
s.advance(600000);
s.hidden = false;
s.advance(14000);
assert.equal(s.tunnel.closed, 0, 'not before the usual timeout');
s.advance(2000);
assert.equal(s.tunnel.closed, 1, 'a silent session is closed as it would have been');

// Hidden again before the check: no close behind the user's back.
s = setup(false);
s.hidden = true;
s.hidden = false;
s.hidden = true;
s.advance(20000);
assert.equal(s.tunnel.closed, 0, 'no check while hidden');

// Opened in a background tab: held off from the start.
s = setup(true);
assert.ok(s.tunnel.receiveTimeout >= 3600 * 1000, 'held off when the page starts hidden');

// Wired to the tunnel every session makes.
assert.match(html, /new Guacamole\.Client\(tunnel\);\s*rgKeepTunnelWhileHidden\(tunnel, document, window\);/);

console.log('client-hidden-tunnel: ok');
