/*
 * The Connect split button's menu, shared by the connections page and the
 * global search (search.js), so a connection offers the same choices
 * wherever it is found: every protocol of the entry (#296), and, for each
 * SSH protocol with tmux on, the host's tmux sessions (#325).
 *
 * A page renders the button with menuHtml() next to its own Connect button,
 * and binds the element holding its rows with bind(root, hooks):
 *
 *   entryOf(sec)            the entry a tmux section belongs to (required)
 *   onPrompt(p, sec, names, btn)  open tmux sessions on a protocol whose
 *                           credentials are typed at connect
 *   onAdvanced(sec)         the Advanced item ("start sessions with commands")
 *   onError(msg)            a failure to show
 *   onSessions(sec)         a section's session list arrived
 *
 * and calls handleClick(ev) first in its click handler: it takes the toggle
 * and the tmux items, and returns true when it did. A protocol item carries
 * the page's own connect attribute, so the page connects it as usual.
 * Keyboard, scrolling, resizing and clicks outside are handled here, for
 * every menu on the page.
 */
(function () {
    'use strict';
    if (window.rgConnectMenu) return;

    var NAME_RE = /^[A-Za-z0-9_\-@+=,~]{1,64}$/;   // crate::tmux::valid_name
    var STANDARD_PORTS = { ssh: 22, rdp: 3389, vnc: 5900, spice: 5900 };
    var roots = [];

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function headers(extra) {
        var h = {}, k = null;
        try { k = sessionStorage.getItem('rustguac_api_key'); } catch (e) {}
        if (k) h['Authorization'] = 'Bearer ' + k;
        if (extra) for (var x in extra) h[x] = extra[x];
        return h;
    }

    // An entry's protocols, primary first; an entry from an older server is
    // its own single protocol.
    function protocols(e) { return (e && e.protocols && e.protocols.length) ? e.protocols : [e]; }
    function protocol(e, name) {
        if (!e || !name) return e;
        var ps = protocols(e);
        for (var i = 0; i < ps.length; i++) if (ps[i].protocol === name) return ps[i];
        return e;
    }
    // A protocol's port as the menu shows it: its own, or its type's
    // standard one; a web protocol's from its URL when it names one.
    function protoPort(p) {
        if (p.session_type === 'web') {
            var m = /^[a-z]+:\/\/[^\/:?#]+:(\d+)/i.exec(p.url || '');
            return m ? m[1] : null;
        }
        return p.port || STANDARD_PORTS[p.session_type] || null;
    }
    // What a protocol without a port connects to, for the menu.
    function protoDetail(p) {
        if (p.session_type === 'proxmox') return p.proxmox_vmid ? 'VM ' + p.proxmox_vmid : '';
        if (p.session_type === 'vdi') return p.container_image || '';
        return '';
    }
    function protoSummary(p) {
        var nm = p.protocol || p.session_type;
        var port = protoPort(p);
        return (nm === p.session_type ? p.session_type.toUpperCase() : nm + ' (' + p.session_type.toUpperCase() + ')') + (port ? ' :' + port : '');
    }
    function tmuxProtocols(e) { return protocols(e).filter(function (p) { return p.session_type === 'ssh' && p.tmux; }); }
    // Several protocols, or tmux sessions on one: the entry gets the menu.
    function hasMenu(e) { return protocols(e).length > 1 || tmuxProtocols(e).length > 0; }

    // The toggle and the menu, to follow the page's Connect button inside a
    // <span class="split-btn">. `attr` is the page's connect attribute, set
    // to the entry's name on each protocol item.
    function menuHtml(e, scope, folder, id, attr) {
        var protos = protocols(e), tmux = tmuxProtocols(e);
        var label = protos.length > 1 ? 'Choose a protocol' : 'tmux sessions';
        var where = ' data-scope="' + esc(scope) + '" data-folder="' + esc(folder) + '"';
        return '<button class="btn-connect split-toggle" data-proto-toggle="1" aria-haspopup="menu" aria-expanded="false" aria-controls="' + esc(id) + '" aria-label="' + label + '" title="' + label + '">&#9662;</button>'
            + '<div class="proto-menu-list" id="' + esc(id) + '" role="menu" aria-label="' + label + '" hidden>'
            + (protos.length < 2 ? '' : protos.map(function (p, pi) {
                var nm = p.protocol || p.session_type;
                var port = protoPort(p), detail = protoDetail(p);
                return '<button type="button" class="proto-item" role="menuitem" tabindex="-1" ' + attr + '="' + esc(e.name) + '"' + where + ' data-protocol="' + esc(nm) + '">'
                    + '<span class="type-badge type-' + esc(p.session_type) + '">' + esc(p.session_type.toUpperCase()) + '</span>'
                    + (nm !== p.session_type ? '<span class="pi-name">' + esc(nm) + '</span>' : '')
                    + (pi === 0 ? '<span class="pi-default">default</span>' : '')
                    + (detail ? '<span class="pi-detail">' + esc(detail) + '</span>' : '')
                    + (port ? '<span class="pi-port">:' + esc(String(port)) + '</span>' : '')
                    + '</button>';
            }).join(''))
            + tmux.map(function (p) { return sectionHtml(e, p, scope, folder, protos.length > 1); }).join('')
            + '</div>';
    }
    function sectionHtml(e, p, scope, folder, multi) {
        var nm = p.protocol || p.session_type;
        var port = protoPort(p);
        var attrs = ' data-entry="' + esc(e.name) + '" data-scope="' + esc(scope) + '" data-folder="' + esc(folder) + '"'
            + (multi || p.protocol ? ' data-protocol="' + esc(nm) + '"' : '');
        return '<div class="tmux-section"' + attrs + '>'
            + '<div class="tmux-head"><span>tmux' + (multi && nm !== 'ssh' ? ' · ' + esc(nm) : '') + '</span>'
            + '<span class="tmux-spin" hidden></span>'
            + (port ? '<span class="th-port">ssh :' + esc(String(port)) + '</span>' : '') + '</div>'
            + '<div class="tmux-list"></div>'
            + '<div class="tmux-presets"></div>'
            + '<form class="tmux-new" autocomplete="off"><input type="text" maxlength="64" spellcheck="false" placeholder="new or existing session" aria-label="tmux session name">'
            + '<button type="submit" class="btn-connect">Open</button></form>'
            + '<button type="button" class="proto-item tmux-adv" role="menuitem" tabindex="-1" data-tmux-advanced="1">'
            + '<span class="type-badge type-preset">MORE</span><span class="pi-name">Advanced: start sessions with commands…</span></button>'
            + '</div>';
    }

    // ── Pages ──
    function bind(root, hooks) {
        for (var i = 0; i < roots.length; i++) if (roots[i].el === root) { roots[i].hooks = hooks; return; }
        roots.push({ el: root, hooks: hooks });
    }
    // The hooks of the page part a section belongs to. A section the
    // Advanced dialog copied, or one a re-render took off the page, keeps
    // the ones it was opened with.
    function hooksOf(sec) {
        var s = sec._orig || sec;
        for (var i = 0; i < roots.length; i++) if (roots[i].el.contains(s)) { s._rgHooks = roots[i].hooks; break; }
        return s._rgHooks || {};
    }
    function entryOf(sec) {
        var s = sec._orig || sec;
        var h = hooksOf(s);
        var e = h.entryOf ? h.entryOf(s) : null;
        if (e) s._rgEntry = e;
        return protocol(s._rgEntry || null, s.getAttribute('data-protocol'));
    }
    function fail(sec, msg) {
        var h = hooksOf(sec);
        if (h.onError) h.onError(msg); else if (window.rgAlert) window.rgAlert(msg);
    }

    // ── tmux sessions (#325) ──
    // Asked of the host (one SSH login with the entry's stored credentials)
    // each time the menu opens. A session opens in the tmux workspace
    // (tmux.html): one tab per connection, holding every session of it as
    // tabs that reconnect on their own.
    function ago(sec) {
        if (!sec) return '';
        var d = Math.max(0, Math.round(Date.now() / 1000 - sec));
        if (d < 60) return 'now';
        if (d < 3600) return Math.floor(d / 60) + 'm';
        if (d < 86400) return Math.floor(d / 3600) + 'h';
        return Math.floor(d / 86400) + 'd';
    }
    function entryUrl(sec) {
        return '/api/addressbook/folders/' + encodeURIComponent(sec.getAttribute('data-scope')) + '/' + encodeURIComponent(sec.getAttribute('data-folder'))
            + '/entries/' + encodeURIComponent(sec.getAttribute('data-entry'));
    }
    function protoQuery(sec) {
        var proto = sec.getAttribute('data-protocol');
        return proto ? '?protocol=' + encodeURIComponent(proto) : '';
    }
    function json(res) {
        return res.json().catch(function () { return {}; }).then(function (j) { return { ok: res.ok, status: res.status, j: j }; });
    }
    function msg(sec, text, isErr) {
        sec.querySelector('.tmux-list').innerHTML = '<div class="tmux-msg' + (isErr ? ' err' : '') + '">' + esc(text) + '</div>';
    }
    function promptsAtConnect(p) { return !!(p && (p.prompt_credentials || !p.has_credentials)); }
    function loadSection(sec) {
        var p = entryOf(sec);
        // Typed in at connect: nothing to log in with on the user's behalf.
        if (promptsAtConnect(p)) {
            msg(sec, 'Credentials are typed at connect, so the sessions on the host cannot be listed. Name one to attach to or start it.');
            var adv = sec.querySelector('[data-tmux-advanced]');
            if (adv) adv.remove();
            return;
        }
        if (!hooksOf(sec).onAdvanced) { var a = sec.querySelector('[data-tmux-advanced]'); if (a) a.remove(); }
        loadPresets(sec);
        var seq = (sec._tmuxSeq || 0) + 1;
        sec._tmuxSeq = seq;
        var spin = sec.querySelector('.tmux-spin');
        spin.hidden = false;
        msg(sec, 'Asking the host…');
        fetch(entryUrl(sec) + '/tmux' + protoQuery(sec), { headers: headers(), credentials: 'same-origin' })
            .then(json)
            .then(function (r) {
                if (sec._tmuxSeq !== seq) return;
                spin.hidden = true;
                if (!r.ok) { msg(sec, r.j.error || 'The host could not be asked.', true); return; }
                if (!r.j.installed) { msg(sec, 'tmux is not installed on this host.', true); return; }
                var sessions = r.j.sessions || [];
                sec._tmuxSessions = sessions;
                var h = hooksOf(sec);
                if (h.onSessions) h.onSessions(sec);
                if (!sessions.length) { msg(sec, 'No tmux sessions running. Name one below to start it.'); return; }
                var openable = sessions.filter(function (s) { return s.attachable; });
                var html = '';
                if (openable.length > 1) {
                    html += '<button type="button" class="proto-item" role="menuitem" tabindex="-1" data-tmux-all="' + esc(openable.map(function (s) { return s.name; }).join(',')) + '">'
                        + '<span class="type-badge type-tmux">TMUX</span><span class="pi-name">Open all ' + openable.length + ' in the workspace</span></button>';
                }
                html += sessions.map(function (s) {
                    var meta = [];
                    if (s.attached) meta.push(s.attached + ' attached');
                    meta.push(s.windows + 'w');
                    if (s.activity) meta.push(ago(s.activity));
                    return '<button type="button" class="proto-item" role="menuitem" tabindex="-1"'
                        + (s.attachable ? ' data-tmux-open="' + esc(s.name) + '"' : ' disabled title="This name has characters rustguac does not pass to a shell"') + '>'
                        + '<span class="type-badge type-tmux">TMUX</span><span class="pi-name">' + esc(s.name) + '</span>'
                        + '<span class="ti-meta">' + esc(meta.join(' · ')) + '</span></button>';
                }).join('');
                sec.querySelector('.tmux-list').innerHTML = html;
                replace(sec);
            })
            .catch(function () { if (sec._tmuxSeq !== seq) return; spin.hidden = true; msg(sec, 'The host could not be reached.', true); });
    }
    function replace(sec) {
        var menu = sec.closest('.proto-menu-list');
        if (menu && !menu.hidden) place(menu);
    }
    // The connection's tmux workspace tab: the one already open (found by
    // its window name, so a second pick adds tabs there instead of opening
    // another workspace) or a new, blank one. Must run inside the click, or
    // the browser blocks it.
    function workspace(sec) {
        var winName = 'rg-tmux:' + sec.getAttribute('data-scope') + '/' + sec.getAttribute('data-folder') + '/' + sec.getAttribute('data-entry') + '/' + (sec.getAttribute('data-protocol') || '');
        var w = window.open('', winName);
        if (!w) return null;
        var existing = false;
        try { existing = w.location.pathname === '/tmux.html'; } catch (e) {}
        return { w: w, existing: existing };
    }
    // Show tmux sessions in a workspace from workspace().
    function show(sec, ws, names) {
        if (ws.existing) {
            names.forEach(function (n) { ws.w.postMessage({ rgTmux: 'open', name: n }, location.origin); });
            try { ws.w.focus(); } catch (e) {}
            return;
        }
        var p = entryOf(sec);
        var scope = sec.getAttribute('data-scope'), folder = sec.getAttribute('data-folder'), name = sec.getAttribute('data-entry');
        var proto = sec.getAttribute('data-protocol') || '';
        var host = (p && p.hostname) || '';
        ws.w.location.href = '/tmux.html?scope=' + encodeURIComponent(scope) + '&folder=' + encodeURIComponent(folder) + '&entry=' + encodeURIComponent(name)
            + (proto ? '&protocol=' + encodeURIComponent(proto) : '')
            + '&label=' + encodeURIComponent((p && p.display_name) || name)
            + (host ? '&host=' + encodeURIComponent(host + (p.port && p.port !== 22 ? ':' + p.port : '')) : '')
            + '&s=' + encodeURIComponent(names.join(',')) + '&active=' + encodeURIComponent(names[names.length - 1]);
    }
    // Open tmux sessions in the connection's workspace tab.
    function openTmux(sec, names, btn) {
        var p = entryOf(sec);
        close(true);
        // Credentials typed at connect are never kept, so the workspace
        // could not reconnect: the page opens a normal session tab instead.
        if (promptsAtConnect(p)) {
            var h = hooksOf(sec);
            if (h.onPrompt) h.onPrompt(p, sec, names, btn);
            return;
        }
        var ws = workspace(sec);
        if (!ws) { fail(sec, 'The browser blocked the tmux workspace window. Allow pop-ups for this site.'); return; }
        show(sec, ws, names);
    }

    // ── Starting tmux sessions with startup commands (#325) ──
    // The host creates each session that is not running yet and types its
    // commands in; one already running is left alone. Then the workspace
    // attaches to them all as usual. The workspace window is opened inside
    // the click (a blank "Starting…" page until the host answers) so the
    // browser does not block it.
    function startAndOpen(sec, specs, done) {
        var ws = workspace(sec);
        if (!ws) { done({ error: 'The browser blocked the tmux workspace window. Allow pop-ups for this site.' }); return; }
        if (!ws.existing) {
            try {
                ws.w.document.title = 'Starting tmux sessions…';
                ws.w.document.body.style.cssText = 'margin:0;background:#0b1220;color:#9fb3c8;font:14px monospace;display:flex;align-items:center;justify-content:center;height:100vh';
                ws.w.document.body.textContent = 'Starting ' + specs.length + ' tmux session' + (specs.length === 1 ? '' : 's') + '…';
            } catch (e) {}
        }
        fetch(entryUrl(sec) + '/tmux/start' + protoQuery(sec), {
            method: 'POST', credentials: 'same-origin',
            headers: headers({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ sessions: specs })
        })
            .then(json)
            .then(function (r) {
                if (!r.ok) {
                    if (!ws.existing) try { ws.w.close(); } catch (e) {}
                    done({ error: r.j.error || 'The sessions could not be started.' });
                    return;
                }
                var sessions = r.j.sessions || [];
                var names = sessions.filter(function (x) { return x.state === 'created' || x.state === 'running'; }).map(function (x) { return x.name; });
                if (names.length) show(sec, ws, names);
                else if (!ws.existing) try { ws.w.close(); } catch (e) {}
                done({ sessions: sessions });
            })
            .catch(function () {
                if (!ws.existing) try { ws.w.close(); } catch (e) {}
                done({ error: 'The host could not be reached.' });
            });
    }
    // One line per session of a start, for whoever asked.
    function startLines(sessions) {
        return sessions.map(function (x) {
            var what = {
                created: x.commands_sent ? 'started, commands typed in' : 'started',
                running: 'already running: opened, nothing typed into it',
                no_dir: 'not started: its folder does not exist on the host',
                failed: 'could not be started'
            }[x.state] || x.state;
            return { name: x.name, text: what, bad: x.state === 'no_dir' || x.state === 'failed' };
        });
    }
    // Saved starts, per user and entry protocol, kept by rustguac.
    function loadPresets(sec) {
        if (!sec.querySelector('.tmux-presets')) return;
        fetch(entryUrl(sec) + '/tmux/presets' + protoQuery(sec), { headers: headers(), credentials: 'same-origin' })
            .then(json)
            .then(function (r) {
                if (!r.ok) return;
                sec._tmuxPresets = r.j.presets || [];
                renderPresets(sec);
            })
            .catch(function () {});
    }
    function renderPresets(sec) {
        var box = sec.querySelector('.tmux-presets');
        if (!box) return;
        box.innerHTML = (sec._tmuxPresets || []).map(function (pr, i) {
            var n = pr.sessions.length;
            return '<button type="button" class="proto-item" role="menuitem" tabindex="-1" data-tmux-preset="' + i + '" title="' + esc(pr.sessions.map(function (x) { return x.name; }).join(', ')) + '">'
                + '<span class="type-badge type-preset">START</span><span class="pi-name">' + esc(pr.name) + '</span>'
                + '<span class="ti-meta">' + n + ' session' + (n === 1 ? '' : 's') + '</span></button>';
        }).join('');
        replace(sec);
    }
    // A preset picked from the menu: started straight away.
    function startPreset(sec, i) {
        var pr = (sec._tmuxPresets || [])[i];
        if (!pr) return;
        close(true);
        startAndOpen(sec, pr.sessions, function (r) {
            if (r.error) { fail(sec, pr.name + ': ' + r.error); return; }
            var bad = startLines(r.sessions).filter(function (l) { return l.bad; });
            if (bad.length) fail(sec, pr.name + ': ' + bad.map(function (l) { return l.name + ' ' + l.text; }).join('; '));
        });
    }

    // ── The menu ──
    function close(refocus) {
        document.querySelectorAll('.proto-menu-list:not([hidden])').forEach(function (m) {
            m.hidden = true;
            var t = m.parentNode.querySelector('[data-proto-toggle]');
            if (t) {
                t.setAttribute('aria-expanded', 'false');
                if (refocus) t.focus();
            }
        });
    }
    function isOpen() { return !!document.querySelector('.proto-menu-list:not([hidden])'); }
    // Below the split button, right-aligned to it; flipped above it or
    // pulled in when that would leave the viewport.
    function place(menu) {
        var anchor = menu.parentNode.getBoundingClientRect();
        var mw = menu.offsetWidth, mh = menu.offsetHeight;
        var vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
        var left = Math.min(anchor.right - mw, vw - mw - 8);
        var top = anchor.bottom + 4;
        if (top + mh > vh - 8) top = anchor.top - mh - 4 >= 8 ? anchor.top - mh - 4 : Math.max(8, vh - mh - 8);
        left = Math.max(8, left);
        menu.style.left = left + 'px';
        menu.style.top = top + 'px';
        // An ancestor with a transform or filter moves the fixed menu's
        // origin off the viewport's; take the difference back off.
        var r = menu.getBoundingClientRect();
        if (r.left !== left || r.top !== top) {
            menu.style.left = (2 * left - r.left) + 'px';
            menu.style.top = (2 * top - r.top) + 'px';
        }
    }
    function open(toggle, focusLast) {
        close(false);
        var menu = toggle.parentNode.querySelector('.proto-menu-list');
        menu.hidden = false;
        toggle.setAttribute('aria-expanded', 'true');
        menu.querySelectorAll('.tmux-section').forEach(loadSection);
        place(menu);
        // Advanced is not a first pick: with nothing else to choose, the
        // tmux name box gets the focus.
        var items = menu.querySelectorAll('[role="menuitem"]:not(.tmux-adv)');
        if (items.length) items[focusLast ? items.length - 1 : 0].focus();
        else { var box = menu.querySelector('.tmux-new input'); if (box) box.focus(); }
    }
    // The toggle and the tmux items; true when the click was one of them.
    function handleClick(ev) {
        var btn = ev.target && ev.target.closest ? ev.target.closest('button') : null;
        if (!btn) return false;
        if (btn.hasAttribute('data-proto-toggle')) {
            if (btn.getAttribute('aria-expanded') === 'true') close(true); else open(btn, false);
            return true;
        }
        var sec = btn.closest('.tmux-section');
        if (!sec) return false;
        if (btn.hasAttribute('data-tmux-advanced')) {
            var h = hooksOf(sec);
            close(false);
            if (h.onAdvanced) h.onAdvanced(sec);
            return true;
        }
        if (btn.hasAttribute('data-tmux-preset')) { startPreset(sec, parseInt(btn.getAttribute('data-tmux-preset'), 10)); return true; }
        if (btn.hasAttribute('data-tmux-open') || btn.hasAttribute('data-tmux-all')) {
            openTmux(sec, (btn.getAttribute('data-tmux-open') || btn.getAttribute('data-tmux-all')).split(','), btn);
            return true;
        }
        return false;
    }

    document.addEventListener('submit', function (ev) {
        var form = ev.target;
        if (!form.classList || !form.classList.contains('tmux-new')) return;
        ev.preventDefault();
        var sec = form.closest('.tmux-section');
        var inp = form.querySelector('input');
        var n = inp.value.trim();
        if (!NAME_RE.test(n)) {
            msg(sec, 'A session name is 1 to 64 letters, digits or _ - @ + = , ~', true);
            inp.focus();
            return;
        }
        openTmux(sec, [n], form.querySelector('button'));
    });
    // Escape closes only the menu: nothing else on the page (the search
    // overlay, a dialog) hears it.
    document.addEventListener('keydown', function (ev) {
        var t = ev.target;
        if (!t || !t.closest) return;
        if (t.hasAttribute && t.hasAttribute('data-proto-toggle')) {
            if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
                ev.preventDefault();
                open(t, ev.key === 'ArrowUp');
            } else if (ev.key === 'Escape' && t.getAttribute('aria-expanded') === 'true') {
                ev.preventDefault(); ev.stopImmediatePropagation(); close(true);
            }
            return;
        }
        var menu = t.closest('.proto-menu-list');
        if (!menu) return;
        // The tmux name box keeps its keys; Escape still closes.
        if (t.tagName === 'INPUT') {
            if (ev.key === 'Escape') { ev.preventDefault(); ev.stopImmediatePropagation(); close(true); }
            return;
        }
        var items = Array.prototype.slice.call(menu.querySelectorAll('[role="menuitem"]:not([disabled])'));
        var i = items.indexOf(t);
        if (ev.key === 'ArrowDown') { ev.preventDefault(); items[(i + 1) % items.length].focus(); }
        else if (ev.key === 'ArrowUp') { ev.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
        else if (ev.key === 'Home') { ev.preventDefault(); items[0].focus(); }
        else if (ev.key === 'End') { ev.preventDefault(); items[items.length - 1].focus(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopImmediatePropagation(); close(true); }
        else if (ev.key === 'Tab') { close(false); }
    }, true);
    // A fixed menu follows its button when the page (or the search results)
    // scrolls, and closes once the button has scrolled out of sight.
    document.addEventListener('scroll', function (ev) {
        if (ev.target && ev.target.closest && ev.target.closest('.proto-menu-list')) return;
        document.querySelectorAll('.proto-menu-list:not([hidden])').forEach(function (m) {
            var a = m.parentNode.getBoundingClientRect();
            if (a.bottom < 0 || a.top > document.documentElement.clientHeight) close(false);
            else place(m);
        });
    }, true);
    window.addEventListener('resize', function () { close(false); });
    // A click anywhere outside the split button closes its menu.
    document.addEventListener('click', function (ev) {
        if (ev.target.closest && ev.target.closest('.split-btn')) return;
        close(false);
    });

    window.rgConnectMenu = {
        NAME_RE: NAME_RE,
        protocols: protocols, protocol: protocol,
        protoPort: protoPort, protoDetail: protoDetail, protoSummary: protoSummary,
        hasMenu: hasMenu, menuHtml: menuHtml,
        bind: bind, handleClick: handleClick,
        open: open, close: close, isOpen: isOpen, place: place,
        entryOf: entryOf, entryUrl: entryUrl, protoQuery: protoQuery, json: json, msg: msg,
        loadPresets: loadPresets, renderPresets: renderPresets,
        startAndOpen: startAndOpen, startLines: startLines
    };
})();
