// #325: an SSH protocol with tmux on. Connect's menu asks the host for its
// tmux sessions (spinner, then the list, or why not), opens them in the
// tmux workspace, and a second pick adds a tab to the workspace already
// open. The workspace attaches each tab, reconnects a lost one on its own,
// leaves a detached one to the user, and shows the tabs one at a time or
// side by side.
import { test, expect } from '@playwright/test';
import { installApi, settle, entry, folder } from '../lib/api.mjs';

const tmuxSsh = (name, extra = {}) => {
    const e = entry(name, 'ssh', { hostname: '10.0.0.30', ...extra, fields: { tmux: true, ...(extra.fields || {}) } });
    return { ...e, protocol: 'ssh', protocols: [{ ...e, protocol: 'ssh' }] };
};
function mixed() {
    const rdp = entry('srv02', 'rdp', { hostname: '10.0.0.31' });
    const ssh = { ...entry('srv02', 'ssh', { hostname: '10.0.0.31', port: 2222, fields: { tmux: true } }), protocol: 'ssh-2222' };
    return { ...rdp, protocol: 'rdp', protocols: [{ ...rdp, protocol: 'rdp' }, ssh] };
}
function folders() {
    return [folder('acme', { entries: [
        tmuxSsh('build01'),
        entry('plain01', 'ssh'),
        mixed(),
        tmuxSsh('prompt01', { fields: { prompt_credentials: true } }),
        tmuxSsh('bare01')
    ] })];
}
const now = Math.floor(Date.now() / 1000);
const LISTING = { installed: true, sessions: [
    { name: 'deploy', attached: 1, windows: 3, created: now - 7200, activity: now - 120, attachable: true },
    { name: 'logs', attached: 0, windows: 1, created: now - 9000, activity: now - 4000, attachable: true },
    { name: 'my notes', attached: 0, windows: 1, created: now - 9000, activity: now - 9000, attachable: false }
] };

async function openAcme(page) {
    await page.goto('/connections.html');
    await settle(page);
    await page.locator('.folder-row').filter({ hasText: /acme/ }).first().click();
    await expect(page.locator('#entries-title')).toHaveText('acme');
}
const row = (page, name) => page.locator('.entries-table tbody tr').filter({ hasText: name });

/* The session client, as the workspace frames it: says 'ready' (or what a
 * test tells it to) to its parent, as client.html does when embedded. */
async function stubClient(context) {
    await context.route('**/client/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><body style="background:#123">
        <script>
        window.rgSay = function (kind, extra) { parent.postMessage(Object.assign({ rgSession: kind }, extra || {}), location.origin); };
        addEventListener('message', function (e) { if (e.data && e.data.rgLauncher === 'viewport') document.body.dataset.viewport = '1'; });
        addEventListener('message', function (e) { if (e.data && e.data.rgLauncher === 'focus') document.body.dataset.focusAsks = String(+(document.body.dataset.focusAsks || 0) + 1); });
        if (!/noready/.test(location.search)) rgSay('ready');
        </script></body>` }));
}
let sessionN = 0;
function newSession() {
    sessionN++;
    const id = `00000000-0000-4000-8000-${String(sessionN).padStart(12, '0')}`;
    return { session_id: id, client_url: `/client/${id}`, ws_url: `/ws/${id}`, session_type: 'ssh' };
}

test('a one-protocol SSH entry with tmux gets a menu that lists the host\'s sessions', async ({ page }) => {
    let release;
    const gate = new Promise(r => { release = r; });
    const api = await installApi(page, { folders: folders(), routes: {
        'GET /api/addressbook/folders/shared/acme/entries/build01/tmux': async () => { await gate; return LISTING; }
    } });
    await openAcme(page);
    // No tmux, one protocol: just Connect.
    await expect(row(page, 'plain01').locator('[data-proto-toggle]')).toHaveCount(0);

    const r = row(page, 'build01');
    await r.locator('[data-proto-toggle]').click();
    const menu = r.locator('.proto-menu-list');
    // Asked of the host when the menu opens, with a spinner meanwhile.
    await expect(menu.locator('.tmux-spin')).toBeVisible();
    await expect(menu.locator('.tmux-msg')).toHaveText('Asking the host…');
    // The name box has focus, ready to type.
    await expect(menu.locator('.tmux-new input')).toBeFocused();
    release();
    await expect(menu.locator('.tmux-spin')).toBeHidden();
    await expect(menu.locator('.tmux-head')).toContainText('ssh :22');
    const items = menu.locator('.tmux-list .proto-item');
    await expect(items).toHaveCount(4);
    await expect(items.nth(0)).toContainText('Open all 2');
    await expect(items.nth(1)).toContainText('deploy');
    await expect(items.nth(1)).toContainText('1 attached · 3w · 2m');
    await expect(items.nth(3)).toBeDisabled();
    const ask = api.calls.filter(c => c.method === 'GET' && /build01\/tmux$/.test(c.path));
    expect(ask).toHaveLength(1);
    expect(ask[0].query.protocol).toBe('ssh');

    // Each opening asks again.
    await page.keyboard.press('Escape');
    await r.locator('[data-proto-toggle]').click();
    await expect.poll(() => api.calls.filter(c => c.method === 'GET' && /build01\/tmux$/.test(c.path)).length).toBe(2);
});

test('a session opens in the workspace, and a second pick adds a tab to it', async ({ page, context }) => {
    await stubClient(context);
    sessionN = 0;
    await installApi(page, { folders: folders(), routes: {
        'GET /api/addressbook/folders/shared/acme/entries/build01/tmux': LISTING
    } });
    const wsCalls = [];
    await context.route('**/api/addressbook/folders/shared/acme/entries/build01/connect', route => {
        wsCalls.push(route.request().postDataJSON());
        route.fulfill({ contentType: 'application/json', body: JSON.stringify(newSession()) });
    });
    await openAcme(page);
    const r = row(page, 'build01');
    await r.locator('[data-proto-toggle]').click();
    const [ws] = await Promise.all([
        page.waitForEvent('popup'),
        r.locator('[data-tmux-open="deploy"]').click()
    ]);
    await ws.waitForURL(/\/tmux\.html/);
    await expect(ws.locator('.tab')).toHaveCount(1);
    await expect(ws.locator('.tab').first()).toContainText('deploy');
    await expect(ws.locator('.tab').first()).toHaveClass(/s-live/);
    await expect(ws.locator('#who-name')).toHaveText('build01');
    await expect(ws.locator('#who-host')).toHaveText('10.0.0.30');
    expect(wsCalls[0]).toMatchObject({ tmux_session: 'deploy', protocol: 'ssh' });
    // The frame was told its viewport is settled.
    await expect.poll(() => ws.frames().length).toBeGreaterThan(1);
    await expect(ws.frameLocator('.pane iframe').first().locator('body')).toHaveAttribute('data-viewport', '1');

    // A second pick: no new window, a new tab in this one.
    let second = false;
    page.on('popup', () => { second = true; });
    await r.locator('[data-proto-toggle]').click();
    await r.locator('[data-tmux-open="logs"]').click();
    await expect(ws.locator('.tab')).toHaveCount(2);
    await expect(ws.locator('.tab.active')).toContainText('logs');
    expect(second).toBe(false);
    expect(wsCalls.map(b => b.tmux_session)).toEqual(['deploy', 'logs']);
});

test('the host without tmux, or without stored credentials, says why', async ({ page }) => {
    const api = await installApi(page, { folders: folders(), routes: {
        'GET /api/addressbook/folders/shared/acme/entries/bare01/tmux': { installed: false, sessions: [] },
        'GET /api/addressbook/folders/shared/acme/entries/build01/tmux': { status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'the host could not be asked: login refused: authentication failed for root@10.0.0.30:22' }) }
    } });
    await openAcme(page);
    let r = row(page, 'bare01');
    await r.locator('[data-proto-toggle]').click();
    await expect(r.locator('.tmux-msg')).toHaveText('tmux is not installed on this host.');
    await expect(r.locator('.tmux-msg')).toHaveClass(/err/);
    await page.keyboard.press('Escape');

    r = row(page, 'build01');
    await r.locator('[data-proto-toggle]').click();
    await expect(r.locator('.tmux-msg')).toContainText('login refused');
    await page.keyboard.press('Escape');

    // Typed in at connect: not asked at all, but a name still opens.
    r = row(page, 'prompt01');
    await r.locator('[data-proto-toggle]').click();
    await expect(r.locator('.tmux-msg')).toContainText('cannot be listed');
    expect(api.calls.some(c => /prompt01\/tmux$/.test(c.path))).toBe(false);
});

test('a typed name is checked, then opens in the workspace', async ({ page, context }) => {
    await stubClient(context);
    await installApi(page, { folders: folders(), routes: {
        'GET /api/addressbook/folders/shared/acme/entries/build01/tmux': LISTING
    } });
    await openAcme(page);
    const r = row(page, 'build01');
    await r.locator('[data-proto-toggle]').click();
    const box = r.locator('.tmux-new input');
    await box.fill('rm -rf;');
    await box.press('Enter');
    await expect(r.locator('.tmux-msg')).toContainText('1 to 64 letters');
    await box.fill('release-42');
    const [ws] = await Promise.all([page.waitForEvent('popup'), box.press('Enter')]);
    await ws.waitForURL(/\/tmux\.html/);
    expect(new URL(ws.url()).searchParams.get('s')).toBe('release-42');
});

test('mixed protocols: the protocol list, then tmux for the SSH protocol that has it', async ({ page }) => {
    const api = await installApi(page, { folders: folders(), routes: {
        'GET /api/addressbook/folders/shared/acme/entries/srv02/tmux': LISTING
    } });
    await openAcme(page);
    const r = row(page, 'srv02');
    await r.locator('[data-proto-toggle]').click();
    const menu = r.locator('.proto-menu-list');
    await expect(menu.locator(':scope > [role="menuitem"]')).toHaveCount(2);
    await expect(menu.locator('.tmux-head')).toContainText('tmux · ssh-2222');
    await expect(menu.locator('.tmux-head')).toContainText('ssh :2222');
    await expect(menu.locator('[data-tmux-open="deploy"]')).toBeVisible();
    expect(api.calls.find(c => /srv02\/tmux$/.test(c.path)).query.protocol).toBe('ssh-2222');
});

test('the workspace reconnects a lost tab, leaves a detached one, and splits', async ({ page, context }) => {
    await stubClient(context);
    sessionN = 0;
    const bodies = [];
    await installApi(page, { routes: {
        'POST /api/addressbook/folders/shared/acme/entries/build01/connect': (req) => { bodies.push(req.postDataJSON()); return newSession(); },
        'GET /api/addressbook/folders/shared/acme/entries/build01/tmux': LISTING,
        'GET /api/addressbook/folders/shared/acme/entries/build01/tmux/repos': { ...LISTING, login: 'root', root: '/root/GitLab', repos: [], other_sessions: [] }
    } });
    await page.goto('/tmux.html?scope=shared&folder=acme&entry=build01&protocol=ssh&label=build01&s=deploy,logs&active=deploy');
    const tabs = page.locator('.tab');
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(0)).toHaveClass(/s-live/);
    await expect(tabs.nth(1)).toHaveClass(/s-live/);
    await expect(page.locator('.tab.active')).toContainText('deploy');
    expect(bodies.map(b => b.tmux_session).sort()).toEqual(['deploy', 'logs']);
    expect(bodies.every(b => b.protocol === 'ssh' && b.width > 0 && b.height > 0)).toBe(true);
    await expect(page).toHaveTitle('build01 — tmux (2)');

    // Tabs: one pane shown. Split: both, side by side.
    const panes = page.locator('.pane');
    await expect(panes.nth(1)).toBeHidden();
    await page.locator('#btn-layout-split').click();
    await expect(panes.nth(0)).toBeVisible();
    await expect(panes.nth(1)).toBeVisible();
    const a = await panes.nth(0).boundingBox(), b = await panes.nth(1).boundingBox();
    expect(Math.abs(a.y - b.y)).toBeLessThan(2);
    expect(b.x).toBeGreaterThan(a.x + a.width - 4);
    await page.locator('#btn-layout-tabs').click();

    // Lost: reconnects on its own, with a new session.
    const deployFrame = page.frameLocator('.pane >> nth=0 >> iframe');
    await deployFrame.locator('body').evaluate(() => window.rgSay('lost', { code: 519, message: 'Connection lost' }));
    await expect(tabs.nth(0)).toHaveClass(/s-reconnecting/);
    await expect(page.locator('.pane').nth(0).locator('.pane-cover')).toContainText('keeps running on the host');
    await expect(tabs.nth(0)).toHaveClass(/s-live/, { timeout: 5000 });
    expect(bodies.filter(b => b.tmux_session === 'deploy')).toHaveLength(2);

    // Refused: no retry loop, the reason instead.
    await page.frameLocator('.pane >> nth=0 >> iframe').locator('body').evaluate(() => window.rgSay('lost', { code: 0x0301, message: 'Permission denied' }));
    await expect(tabs.nth(0)).toHaveClass(/s-error/);
    await expect(page.locator('.pane').nth(0).locator('.pane-cover')).toContainText('Permission denied');
    await page.locator('.pane').nth(0).locator('button[data-act="retry"]').click();
    await expect(tabs.nth(0)).toHaveClass(/s-live/);

    // Ended cleanly while the tmux session still runs on the host (a
    // session time limit, an admin): asks the host, then reattaches.
    const say = (i, kind, extra) => page.frameLocator(`.pane >> nth=${i} >> iframe`).locator('body')
        .evaluate((_, a) => window.rgSay(a[0], a[1]), [kind, extra]);
    await tabs.nth(1).click();
    let n = bodies.length;
    await say(1, 'end');
    await expect.poll(() => bodies.length).toBe(n + 1);
    await expect(tabs.nth(1)).toHaveClass(/s-live/);
    expect(bodies[bodies.length - 1].tmux_session).toBe('logs');
    // Ending again soon after attaching: left to the user, no loop.
    n = bodies.length;
    await say(1, 'end');
    await expect(tabs.nth(1)).toHaveClass(/s-detached/);
    await expect(page.locator('.pane').nth(1).locator('.pane-cover')).toContainText('Detached from logs');
    await page.waitForTimeout(1000);
    expect(bodies.length).toBe(n);
    await page.locator('.pane').nth(1).locator('button[data-act="retry"]').click();
    await expect(tabs.nth(1)).toHaveClass(/s-live/);

    // + Session lists the host's sessions; a new name opens a third tab.
    await page.locator('#btn-add').click();
    await expect(page.locator('#pop-list .pop-item').filter({ hasText: 'deploy' })).toContainText('open');
    await page.locator('#pop-name').fill('scratch');
    await page.locator('#pop-name').press('Enter');
    await expect(tabs).toHaveCount(3);
    await expect(page.locator('.tab.active')).toContainText('scratch');
    expect(new URL(page.url()).searchParams.get('s')).toBe('deploy,logs,scratch');
    // Ended, and the host no longer has it: says so, starts again on request.
    await say(2, 'end');
    await expect(tabs.nth(2)).toHaveClass(/s-detached/);
    await expect(page.locator('.pane').nth(2).locator('.pane-cover')).toContainText('scratch has ended');
    await expect(page.locator('.pane').nth(2).locator('button[data-act="retry"]')).toHaveText('Start it again');

    // Close a tab: gone, the session left running.
    await tabs.nth(2).locator('.tab-x').click();
    await expect(tabs).toHaveCount(2);

    // Nothing here ends a session: that is done from its own shell.
    await tabs.nth(1).click({ button: 'right' });
    await expect(page.locator('#rg-dialog-ok')).toHaveCount(0);
    await expect(page.locator('[data-act="kill"]')).toHaveCount(0);
    await expect(tabs).toHaveCount(2);
});

test('a reconnect ends the session it replaces, and the session limit is waited out', async ({ page, context }) => {
    await stubClient(context);
    sessionN = 0;
    let capped = 1;
    const made = [];
    const api = await installApi(page, { routes: {
        'POST /api/addressbook/folders/shared/acme/entries/build01/connect': () => {
            // The first reconnect meets the limit, as when older sessions
            // have not ended yet.
            if (made.length === 1 && capped-- > 0) return { status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'validation error: maximum sessions per user reached (10)' }) };
            const s = newSession(); made.push(s.session_id); return s;
        },
        'GET /api/addressbook/folders/shared/acme/entries/build01/tmux': LISTING
    } });
    await page.goto('/tmux.html?scope=shared&folder=acme&entry=build01&protocol=ssh&label=build01&s=deploy');
    const tab = page.locator('.tab').first();
    await expect(tab).toHaveClass(/s-live/);
    const deletes = () => api.calls.filter(c => c.method === 'DELETE' && c.path.startsWith('/api/sessions/')).map(c => c.path.split('/').pop());
    // Lost: the next attempt ends the old session before making a new one,
    // and the limit is retried rather than shown as a failure.
    await page.frameLocator('.pane iframe').locator('body').evaluate(() => window.rgSay('lost', { code: 519, message: 'gone' }));
    await expect(tab).toHaveClass(/s-live/, { timeout: 10000 });
    expect(made).toHaveLength(2);
    expect(deletes()).toEqual([made[0]]);
    await expect(page.locator('.pane-cover.on')).toHaveCount(0);
    // Closing the tab ends its session too.
    await tab.locator('.tab-x').click();
    await expect.poll(deletes).toEqual([made[0], made[1]]);
});

test('many tabs connect a few at a time', async ({ page, context }) => {
    await stubClient(context);
    sessionN = 0;
    let n = 0;
    await installApi(page, { routes: {
        // Frames that never say ready: each attempt holds its slot.
        'POST /api/addressbook/folders/shared/acme/entries/build01/connect': () => { n++; const s = newSession(); return { ...s, client_url: s.client_url + '?noready=1' }; },
        'GET /api/addressbook/folders/shared/acme/entries/build01/tmux': LISTING
    } });
    await page.goto('/tmux.html?scope=shared&folder=acme&entry=build01&protocol=ssh&label=build01&s=a1,a2,a3,a4,a5&active=a5');
    await expect.poll(() => n).toBe(3);
    await page.waitForTimeout(500);
    expect(n).toBe(3);
    await expect(page.locator('.pane-cover.on', { hasText: 'Waiting to attach' })).toHaveCount(2);
    // A tab closed frees its slot for the next.
    await page.locator('.tab').first().locator('.tab-x').click();
    await expect.poll(() => n).toBe(4);
});

const TMUX_URL = '/api/addressbook/folders/shared/acme/entries/build01/tmux';

test('Advanced starts sessions with startup commands, then opens them all', async ({ page, context }) => {
    await stubClient(context);
    sessionN = 0;
    let presets = [];
    const api = await installApi(page, { folders: folders(), routes: {
        [`GET ${TMUX_URL}`]: LISTING,
        [`GET ${TMUX_URL}/presets`]: () => ({ presets }),
        [`PUT ${TMUX_URL}/presets`]: (req) => { presets = req.postDataJSON().presets; return { presets }; },
        [`POST ${TMUX_URL}/start`]: (req) => ({ installed: true, no_base64: false, sessions: req.postDataJSON().sessions.map(s => ({
            name: s.name,
            state: s.name === 'deploy' ? 'running' : s.dir === '/nope' ? 'no_dir' : 'created',
            commands_sent: s.name !== 'deploy' && s.dir !== '/nope' && !!s.commands
        })) })
    } });
    await context.route('**/connect', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(newSession()) }));
    await openAcme(page);
    const r = row(page, 'build01');
    await r.locator('[data-proto-toggle]').click();
    await expect(r.locator('.tmux-list [data-tmux-open="deploy"]')).toBeVisible();
    await r.locator('[data-tmux-advanced]').click();
    const dlg = page.locator('#tmux-start-modal');
    await expect(dlg).toHaveClass(/active/);
    await expect(page.locator('#ts-target')).toContainText('10.0.0.30 :22');

    // Rows: one to start with, more on request; a running one is marked.
    await dlg.locator('.ts-name').nth(0).fill('billing');
    await dlg.locator('.ts-dir').nth(0).fill('/srv/billing');
    await dlg.locator('.ts-cmd').nth(0).fill('IS_SANDBOX=1 claude --continue');
    await dlg.locator('.ts-cmd').nth(0).press('Enter');
    await expect(dlg.locator('.ts-name')).toHaveCount(2);
    await expect(dlg.locator('.ts-name').nth(1)).toBeFocused();
    await dlg.locator('.ts-name').nth(1).fill('deploy');
    await dlg.locator('.ts-cmd').nth(1).fill('make deploy');
    await expect(dlg.locator('.ts-state').nth(1)).toContainText('already running');
    await expect(page.locator('#ts-start')).toHaveText('Start 2 sessions');

    // As text: the same rows, one per line; a pasted batch comes back as rows.
    await page.locator('#ts-as-text').click();
    await expect(page.locator('#ts-text')).toHaveValue('billing @/srv/billing "IS_SANDBOX=1 claude --continue"\ndeploy "make deploy"');
    await page.locator('#ts-text').fill([
        'billing @/srv/billing "IS_SANDBOX=1 claude --continue"',
        '# a comment',
        'auth: cd /srv/auth; claude --continue',
        'gone @/nope "echo x"',
        'deploy "make deploy"'
    ].join('\n'));
    await expect(page.locator('#ts-start')).toHaveText('Start 4 sessions');
    await page.locator('#ts-as-rows').click();
    await expect(dlg.locator('.ts-name')).toHaveCount(4);
    await expect(dlg.locator('.ts-cmd').nth(1)).toHaveValue('cd /srv/auth; claude --continue');
    await expect(dlg.locator('.ts-dir').nth(2)).toHaveValue('/nope');

    // A bad name stops it before anything is sent.
    await dlg.locator('.ts-name').nth(1).fill('auth entik');
    await expect(dlg.locator('.ts-state').nth(1)).toContainText('only');
    await page.locator('#ts-start').click();
    await expect(page.locator('#ts-error')).toContainText('session name');
    expect(api.calls.some(c => c.path.endsWith('/tmux/start'))).toBe(false);
    await dlg.locator('.ts-name').nth(1).fill('auth');

    // Saved as a preset, which the Connect menu then offers.
    await page.locator('#ts-save-name').fill('claude fleet');
    await page.locator('#ts-save').click();
    await expect(page.locator('#ts-saved')).toContainText('Saved');
    expect(presets).toHaveLength(1);
    expect(presets[0].sessions.map(s => s.name)).toEqual(['billing', 'auth', 'gone', 'deploy']);
    await expect(page.locator('#ts-preset option:checked')).toHaveText('claude fleet (4)');

    // Start: the host's answer per session; created and running ones open.
    const [ws] = await Promise.all([page.waitForEvent('popup'), page.locator('#ts-start').click()]);
    const start = api.calls.find(c => c.path.endsWith('/tmux/start'));
    expect(start.query).toEqual({ protocol: 'ssh' });
    expect(start.body.sessions[0]).toEqual({ name: 'billing', dir: '/srv/billing', commands: 'IS_SANDBOX=1 claude --continue' });
    await ws.waitForURL(/\/tmux\.html/);
    expect(new URL(ws.url()).searchParams.get('s')).toBe('billing,auth,deploy');
    await expect(ws.locator('.tab')).toHaveCount(3);
    // The missing folder is reported, and the dialog stays open to say so.
    await expect(page.locator('#ts-results')).toContainText('gone: not started: its folder does not exist on the host');
    await expect(page.locator('#ts-results')).toContainText('deploy: already running: opened, nothing typed into it');
    await expect(dlg).toHaveClass(/active/);
});

test('a batch pasted into a row becomes one row per line', async ({ page }) => {
    await installApi(page, { folders: folders(), routes: { [`GET ${TMUX_URL}`]: LISTING } });
    await openAcme(page);
    const r = row(page, 'build01');
    await r.locator('[data-proto-toggle]').click();
    await r.locator('[data-tmux-advanced]').click();
    const dlg = page.locator('#tmux-start-modal');
    const blob = Array.from({ length: 10 }, (_, i) => `s${i} @/srv/p${i} "cd x; claude --continue"`).join('\n');
    await dlg.locator('.ts-name').first().focus();
    await page.evaluate((text) => {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, blob);
    await expect(dlg.locator('.ts-name')).toHaveCount(10);
    await expect(dlg.locator('.ts-name').nth(9)).toHaveValue('s9');
    await expect(dlg.locator('.ts-dir').nth(9)).toHaveValue('/srv/p9');
    await expect(dlg.locator('.ts-cmd').nth(9)).toHaveValue('cd x; claude --continue');
    await expect(page.locator('#ts-start')).toHaveText('Start 10 sessions');
});

test('a preset in the Connect menu starts straight away', async ({ page, context }) => {
    await stubClient(context);
    sessionN = 0;
    const presets = [{ name: 'fleet', sessions: [{ name: 'a1', dir: '', commands: 'top' }, { name: 'a2', dir: '~/x', commands: '' }] }];
    const api = await installApi(page, { folders: folders(), routes: {
        [`GET ${TMUX_URL}`]: LISTING,
        [`GET ${TMUX_URL}/presets`]: { presets },
        [`POST ${TMUX_URL}/start`]: (req) => ({ installed: true, no_base64: false, sessions: req.postDataJSON().sessions.map(s => ({ name: s.name, state: 'created', commands_sent: !!s.commands })) })
    } });
    await context.route('**/connect', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(newSession()) }));
    await openAcme(page);
    const r = row(page, 'build01');
    await r.locator('[data-proto-toggle]').click();
    const item = r.locator('[data-tmux-preset="0"]');
    await expect(item).toContainText('fleet');
    await expect(item).toContainText('2 sessions');
    const [ws] = await Promise.all([page.waitForEvent('popup'), item.click()]);
    await ws.waitForURL(/\/tmux\.html/);
    expect(new URL(ws.url()).searchParams.get('s')).toBe('a1,a2');
    expect(api.calls.find(c => c.path.endsWith('/tmux/start')).body.sessions).toEqual(presets[0].sessions);

    // An entry whose credentials are typed at connect offers neither.
    await page.keyboard.press('Escape');
    const pr = row(page, 'prompt01');
    await pr.locator('[data-proto-toggle]').click();
    await expect(pr.locator('.tmux-msg')).toContainText('typed at connect');
    await expect(pr.locator('[data-tmux-advanced]')).toHaveCount(0);
});

test('a host without tmux, or a failed start, is reported in the dialog', async ({ page }) => {
    await installApi(page, { folders: folders(), routes: {
        [`GET ${TMUX_URL}`]: LISTING,
        [`POST ${TMUX_URL}/start`]: { status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'tmux is not installed on this host', installed: false }) }
    } });
    await openAcme(page);
    const r = row(page, 'build01');
    await r.locator('[data-proto-toggle]').click();
    await r.locator('[data-tmux-advanced]').click();
    await page.locator('#tmux-start-modal .ts-name').first().fill('one');
    const popup = page.waitForEvent('popup');
    await page.locator('#ts-start').click();
    const w = await popup;
    await expect(page.locator('#ts-error')).toHaveText('tmux is not installed on this host');
    // The blank workspace window opened for it is closed again.
    await expect.poll(() => w.isClosed()).toBe(true);
    // Closed and opened again: the rows typed so far are kept.
    await page.keyboard.press('Escape');
    await r.locator('[data-proto-toggle]').click();
    await r.locator('[data-tmux-advanced]').click();
    await expect(page.locator('#tmux-start-modal .ts-name').first()).toHaveValue('one');
});

test('the editor saves tmux on an SSH entry', async ({ page }) => {
    const api = await installApi(page, { folders: [folder('acme', { entries: [entry('plain01', 'ssh')] })] });
    await openAcme(page);
    await page.locator('button[data-edit-entry="plain01"]').click();
    await expect(page.locator('#em-ssh-tmux')).not.toBeChecked();
    await page.locator('#em-ssh-tmux').check();
    await page.locator('#em-save').click();
    await expect.poll(() => api.calls.find(c => c.method === 'PUT' && /entries\/plain01$/.test(c.path))).toBeTruthy();
    const body = api.calls.find(c => c.method === 'PUT' && /entries\/plain01$/.test(c.path)).body;
    const ssh = body.protocols ? body.protocols[0] : body;
    expect(ssh.tmux).toBe(true);
});

test('switching tabs gives the session the keyboard, without a click', async ({ page, context }) => {
    await stubClient(context);
    sessionN = 0;
    await installApi(page, { routes: {
        'POST /api/addressbook/folders/shared/acme/entries/build01/connect': () => newSession(),
        'GET /api/addressbook/folders/shared/acme/entries/build01/tmux': LISTING
    } });
    await page.goto('/tmux.html?scope=shared&folder=acme&entry=build01&protocol=ssh&label=build01&s=deploy,logs&active=deploy');
    const tabs = page.locator('.tab');
    await expect(tabs.nth(1)).toHaveClass(/s-live/);
    const asks = (i) => page.locator('.pane iframe').nth(i).evaluate(f => +(f.contentDocument.body.dataset.focusAsks || 0));
    const before = await asks(1);
    await tabs.nth(1).click();
    await expect.poll(() => asks(1)).toBeGreaterThan(before);
    // The frame asked is the one shown, and it has the page's focus.
    expect(await page.evaluate(() => document.activeElement === document.querySelectorAll('.pane iframe')[1])).toBe(true);
    const back = await asks(0);
    await tabs.nth(0).click();
    await expect.poll(() => asks(0)).toBeGreaterThan(back);
});

test('tabs are all one width, whatever their sessions are called', async ({ page, context }) => {
    await stubClient(context);
    sessionN = 0;
    await installApi(page, { routes: {
        'POST /api/addressbook/folders/shared/acme/entries/build01/connect': () => newSession(),
        'GET /api/addressbook/folders/shared/acme/entries/build01/tmux': LISTING
    } });
    const names = ['a', 'logs', 'a-very-long-session-name-that-does-not-fit-a-tab', 'deploy', 'x1', 'observability'];
    await page.setViewportSize({ width: 700, height: 600 });
    await page.goto('/tmux.html?scope=shared&folder=acme&entry=build01&protocol=ssh&label=build01&s=' + names.join(','));
    const tabs = page.locator('.tab');
    await expect(tabs).toHaveCount(names.length);
    const boxes = await tabs.evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) }; }));
    expect(new Set(boxes.map(b => b.w)).size).toBe(1);
    // They wrap into rows, in columns: every tab starts where one of the
    // first row's does.
    const rows = new Set(boxes.map(b => b.y));
    expect(rows.size).toBeGreaterThan(1);
    const firstRow = boxes.filter(b => b.y === boxes[0].y).map(b => b.x);
    expect(boxes.every(b => firstRow.includes(b.x))).toBe(true);
    // The long name is cut short, and whole in the tooltip; its close
    // button stays inside the tab.
    const long = tabs.nth(2);
    await expect(long).toHaveAttribute('title', new RegExp('^' + names[2]));
    const tb = await long.boundingBox(), xb = await long.locator('.tab-x').boundingBox();
    expect(xb.x + xb.width).toBeLessThanOrEqual(tb.x + tb.width);
});

test('a tab connecting in the background does not take the keyboard', async ({ page, context }) => {
    // A session frame that focuses itself as it loads, as a client would
    // that grabbed the keyboard on connecting.
    await context.route('**/client/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><body>
        <script>
        if (/logs/.test(decodeURIComponent(location.search))) { var i = document.createElement('input'); document.body.appendChild(i); i.focus(); }
        setTimeout(function () { parent.postMessage({ rgSession: 'ready' }, location.origin); }, /logs/.test(decodeURIComponent(location.search)) ? 400 : 0);
        </script></body>` }));
    sessionN = 0;
    await installApi(page, { routes: {
        'POST /api/addressbook/folders/shared/acme/entries/build01/connect': () => newSession(),
        'GET /api/addressbook/folders/shared/acme/entries/build01/tmux': LISTING
    } });
    await page.goto('/tmux.html?scope=shared&folder=acme&entry=build01&protocol=ssh&label=build01&s=deploy,logs&active=deploy');
    const tabs = page.locator('.tab');
    await expect(tabs.nth(0)).toHaveClass(/s-live/);
    await expect(tabs.nth(1)).toHaveClass(/s-live/);
    // The active tab is still deploy, and its frame has the page's focus.
    await expect(page.locator('.tab.active')).toContainText('deploy');
    await expect.poll(() => page.evaluate(() => document.activeElement === document.querySelector('.pane.active iframe'))).toBe(true);
});

test('the active tab connecting does not take the keyboard from the + popover', async ({ page, context }) => {
    await context.route('**/client/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><body>
        <script>setTimeout(function () { parent.postMessage({ rgSession: 'ready' }, location.origin); }, 500);</script></body>` }));
    sessionN = 0;
    await installApi(page, { routes: {
        'POST /api/addressbook/folders/shared/acme/entries/build01/connect': () => newSession(),
        'GET /api/addressbook/folders/shared/acme/entries/build01/tmux': LISTING,
        'GET /api/addressbook/folders/shared/acme/entries/build01/tmux/repos': { ...LISTING, login: 'root', root: '/root/GitLab', repos: [], other_sessions: [] }
    } });
    await page.goto('/tmux.html?scope=shared&folder=acme&entry=build01&protocol=ssh&label=build01&s=deploy');
    await page.locator('#btn-add').click();
    await page.locator('#pop-q').pressSequentially('lo');
    await expect(page.locator('.tab').first()).toHaveClass(/s-live/);
    await expect(page.locator('#pop-q')).toBeFocused();
});
