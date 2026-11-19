// The tmux workspace's + popover lists every
// git.example.com repo in the login's ~/GitLab, from the same host login as
// the sessions (the login's own only). A green dot means a session runs
// in that folder and opens it; a black dot means none and starts one there
// (with the remembered startup command), then opens it. One search box
// filters sessions and repos.
import { test, expect } from '@playwright/test';
import { installApi } from '../lib/api.mjs';

const now = Math.floor(Date.now() / 1000);
const BASE = '/api/addressbook/folders/shared/acme/entries/bench';
const REPOS = {
    installed: true, login: 'root', root: '/root/GitLab',
    sessions: [
        { name: 'rustguac-tmux', attached: 1, windows: 1, created: now - 600, activity: now - 60, attachable: true, path: '/root/GitLab/acme/console' },
        { name: 'scratch', attached: 0, windows: 1, created: now - 900, activity: now - 500, attachable: true, path: '/root' }
    ],
    repos: [
        { path: '/root/GitLab/acme/billing', rel: 'acme/billing', name: 'billing', sessions: [] },
        { path: '/root/GitLab/acme/console', rel: 'acme/console', name: 'rustguac-tmux', sessions: ['rustguac-tmux'] },
        { path: '/root/GitLab/acme/scratch', rel: 'acme/scratch', name: 'scratch', sessions: [] }
    ],
    other_sessions: ['scratch']
};

async function stubClient(context) {
    await context.route('**/client/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><body>
        <script>parent.postMessage({ rgSession: 'ready' }, location.origin);</script></body>` }));
}
let n = 0;
const newSession = () => { n++; const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`; return { session_id: id, client_url: `/client/${id}`, ws_url: `/ws/${id}`, session_type: 'ssh' }; };

test('repos show green and black dots, search filters, green opens, black starts in the folder', async ({ page, context }) => {
    await stubClient(context);
    const starts = [], connects = [];
    const api = await installApi(page, { routes: {
        [`GET ${BASE}/tmux/repos`]: REPOS,
        [`GET ${BASE}/tmux`]: REPOS,
        [`POST ${BASE}/connect`]: (req) => { connects.push(req.postDataJSON()); return newSession(); },
        [`POST ${BASE}/tmux/start`]: (req) => {
            const b = req.postDataJSON(); starts.push(b);
            return { installed: true, no_base64: false, sessions: b.sessions.map(s => ({ name: s.name, state: 'created', commands_sent: !!s.commands })) };
        }
    } });
    await page.goto('/tmux.html?scope=shared&folder=acme&entry=bench&protocol=ssh&label=bench');
    // No tabs: the popover opens by itself, search box focused.
    await expect(page.locator('#add-pop')).toBeVisible();
    await expect(page.locator('#pop-q')).toBeFocused();
    await expect(page.locator('#pop-who')).toHaveText('Sessions, as root');
    await expect(page.locator('#repo-title')).toHaveText('Repos in ~/GitLab (3)');
    const repoRows = page.locator('#repo-list .pop-item');
    await expect(repoRows).toHaveCount(3);
    await expect(repoRows.filter({ hasText: 'acme/console' }).locator('.rdot')).toHaveClass(/on/);
    await expect(repoRows.filter({ hasText: 'acme/billing' }).locator('.rdot')).toHaveClass(/off/);
    // The session row names its repo.
    await expect(page.locator('#pop-list .pop-item').filter({ hasText: 'rustguac-tmux' })).toContainText('acme/console');
    expect(api.calls.filter(c => c.method === 'GET' && /\/tmux\/repos$/.test(c.path)).length).toBe(1);

    // Search narrows both lists.
    await page.locator('#pop-q').fill('bill');
    await expect(repoRows).toHaveCount(1);
    await expect(page.locator('#pop-list')).toContainText('No session matches.');

    // A black repo starts a session in its folder with the startup command.
    // Its name, "scratch", is taken by a session elsewhere, so it gets -2.
    await page.locator('#pop-q').fill('acme/scratch');
    await page.locator('#repo-cmd-in').fill('claude');
    await repoRows.first().click();
    await expect.poll(() => starts.length).toBe(1);
    expect(starts[0].sessions).toEqual([{ name: 'scratch-2', dir: '/root/GitLab/acme/scratch', commands: 'claude' }]);
    await expect(page.locator('.tab')).toHaveCount(1);
    await expect(page.locator('.tab-name')).toHaveText('scratch-2');
    await expect.poll(() => connects.map(c => c.tmux_session)).toEqual(['scratch-2']);
    // The command is remembered in this browser.
    expect(await page.evaluate(() => localStorage.getItem('rg-tmux-repo-cmd'))).toBe('claude');

    // A green repo opens its running session; Enter in the search picks the first match.
    await page.locator('#btn-add').click();
    await page.locator('#pop-q').fill('guac');
    await page.locator('#pop-q').press('Enter');
    await expect(page.locator('.tab')).toHaveCount(2);
    await expect(page.locator('.tab.active .tab-name')).toHaveText('rustguac-tmux');
    expect(starts.length).toBe(1);
});

test('a host without repos or without tmux says so', async ({ page }) => {
    await installApi(page, { routes: {
        [`GET ${BASE}/tmux/repos`]: { installed: false, login: 'alice-example.com', root: '/home/alice-example.com/GitLab', sessions: [], repos: [{ path: '/home/alice-example.com/GitLab/acme/x', rel: 'acme/x', name: 'x', sessions: [] }], other_sessions: [] }
    } });
    await page.goto('/tmux.html?scope=shared&folder=acme&entry=bench&label=bench');
    await expect(page.locator('#pop-list')).toContainText('tmux is not installed on this host.');
    await expect(page.locator('#repo-title')).toHaveText('Repos in ~/GitLab (1)');
    await expect(page.locator('#repo-list .pop-item')).toBeDisabled();
    await expect(page.locator('#repo-cmd')).toBeHidden();
});

test('the repo list fits a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await installApi(page, { routes: { [`GET ${BASE}/tmux/repos`]: REPOS } });
    await page.goto('/tmux.html?scope=shared&folder=acme&entry=bench&label=bench');
    await expect(page.locator('#repo-list .pop-item')).toHaveCount(3);
    const box = await page.locator('#add-pop').boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("the console's default startup command names Claude after the repo, until you set your own", async ({ page, context }) => {
    await stubClient(context);
    const starts = [];
    const repos = { ...REPOS, default_command: 'claude -n {repo}', repos: [...REPOS.repos, { path: "/root/GitLab/acme/it's odd", rel: "acme/it's odd", name: 'it-s-odd', sessions: [] }] };
    await installApi(page, { routes: {
        [`GET ${BASE}/tmux/repos`]: repos,
        [`GET ${BASE}/tmux`]: repos,
        [`POST ${BASE}/connect`]: () => newSession(),
        [`POST ${BASE}/tmux/start`]: (req) => {
            const b = req.postDataJSON(); starts.push(b);
            return { installed: true, no_base64: false, sessions: b.sessions.map(s => ({ name: s.name, state: 'created', commands_sent: !!s.commands })) };
        }
    } });
    await page.goto('/tmux.html?scope=shared&folder=acme&entry=bench&protocol=ssh&label=bench');
    const cmd = page.locator('#repo-cmd-in'), reset = page.locator('#repo-cmd-reset');
    const rows = page.locator('#repo-list .pop-item');
    // A started session closes the popover once the host answers; wait for
    // that, or the next start races it and clicks a row as it disappears.
    const pop = page.locator('#add-pop');
    const start = async (text) => {
        if (await pop.isHidden()) await page.locator('#btn-add').click();
        await rows.filter({ hasText: text }).click();
        await expect(pop).toBeHidden();
    };
    // The default shows in the box, and is not stored as the person's own.
    await expect(cmd).toHaveValue('claude -n {repo}');
    await expect(reset).toBeHidden();
    await start('billing');
    await expect.poll(() => starts.length).toBe(1);
    expect(starts[0].sessions).toEqual([{ name: 'billing', dir: '/root/GitLab/acme/billing', commands: 'claude -n billing' }]);
    expect(await page.evaluate(() => localStorage.getItem('rg-tmux-repo-cmd'))).toBe(null);
    // {repo} is the folder's name, not the session's (scratch-2, as
    // "scratch" runs elsewhere); a name a shell would split is quoted.
    await start('acme/scratch');
    await expect.poll(() => starts.length).toBe(2);
    expect(starts[1].sessions[0]).toMatchObject({ name: 'scratch-2', commands: 'claude -n scratch' });
    await start('odd');
    await expect.poll(() => starts.length).toBe(3);
    expect(starts[2].sessions[0].commands).toBe("claude -n 'it'\\''s odd'");

    // Their own command, with the other placeholders, is remembered; an
    // empty one runs nothing; Default goes back to the console's.
    await page.locator('#btn-add').click();
    await cmd.fill('cd {path} && echo {session} {rel}');
    await cmd.blur();
    await expect(reset).toBeVisible();
    await page.reload();
    await expect(cmd).toHaveValue('cd {path} && echo {session} {rel}');
    await start('billing');
    await expect.poll(() => starts.length).toBe(4);
    expect(starts[3].sessions[0].commands).toBe('cd /root/GitLab/acme/billing && echo billing acme/billing');
    await page.locator('#btn-add').click();
    await cmd.fill('');
    await cmd.blur();
    expect(await page.evaluate(() => localStorage.getItem('rg-tmux-repo-cmd'))).toBe('');
    await reset.click();
    await expect(cmd).toHaveValue('claude -n {repo}');
    await expect(reset).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem('rg-tmux-repo-cmd'))).toBe(null);
});
