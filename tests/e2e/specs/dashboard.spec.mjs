// The per-user dashboard. "Mine" (the default) asks only your own work
// bench folder's connections; "All users" asks every tmux connection you
// may open (an admin sees everyone's work bench folder) and says whose each
// session is. Sessions where Claude waits on you come first, prompts before
// finished replies, each with what Claude said, one-tap choices and an
// answer box; Open goes to the tmux workspace, Open all opens every running
// session. Repos show green/black dots and start a session in the folder.
// It fits a phone.
import { test, expect } from '@playwright/test';
import { installApi, entry, folder } from '../lib/api.mjs';

const BENCH = '192.0.2.10', HOST = 'bench.example.com';
const tmuxSsh = (name, host, extra = {}) => {
    const e = entry(name, 'ssh', { hostname: host, ...extra, fields: { tmux: true, ...(extra.fields || {}) } });
    return { ...e, protocol: 'ssh', protocols: [{ ...e, protocol: 'ssh' }] };
};
const folders = () => [
    folder('staff', { display_name: 'Staff servers', entries: [tmuxSsh(HOST, BENCH), tmuxSsh('web01', '10.0.0.5')] }),
    folder('wb-tester-example-com', { display_name: 'Work Bench - tester@example.com', entries: [tmuxSsh(HOST, BENCH, { username: 'tester' })] }),
    folder('wb-alice-example-com', { display_name: 'Work Bench - alice@example.com', entries: [tmuxSsh(HOST, BENCH, { username: 'alice' })] }),
];
const now = Math.floor(Date.now() / 1000);
const url = (f, e = HOST) => `/api/addressbook/folders/shared/${f}/entries/${e}`;
const MY = 'wb-tester-example-com', ALICE = 'wb-alice-example-com';
const MINE = {
    installed: true, login: 'tester', root: '/home/tester/GitLab',
    sessions: [
        { name: 'billing', attached: 0, windows: 1, created: now - 900, activity: now - 300, attachable: true, path: '/home/tester/GitLab/acme/billing', command: 'claude', title: '✳ Invoices for October',
          claude: { state: 'ready', excerpt: ['● Done: 12 invoices drafted.', '  Want me to send them?'] } },
        { name: 'console', attached: 1, windows: 1, created: now - 900, activity: now - 30, attachable: true, path: '/home/tester/GitLab/acme/console', command: 'claude', title: '✳ Dashboard',
          claude: { state: 'asking', excerpt: ['● Bash(cargo test)', '│ Do you want to proceed?', '│ ❯ 1. Yes', '│   2. Yes, and don\'t ask again', '│   3. No, and tell Claude what to do differently'] } },
        { name: 'deploy', attached: 0, windows: 1, created: now - 900, activity: now - 5, attachable: true, path: '/home/tester/GitLab/acme/ansible', command: 'claude', title: '✳ Apply firewall',
          claude: { state: 'working', excerpt: [] } },
        { name: 'scratch', attached: 0, windows: 1, created: now - 900, activity: now - 4000, attachable: true, path: '/home/tester', command: 'zsh' },
        { name: 'my notes', attached: 0, windows: 1, created: now - 900, activity: now - 5000, attachable: false, path: '/home/tester', command: 'vim' }
    ],
    repos: [
        { path: '/home/tester/GitLab/acme/ansible', rel: 'acme/ansible', name: 'ansible', sessions: ['deploy'] },
        { path: '/home/tester/GitLab/acme/billing', rel: 'acme/billing', name: 'billing', sessions: ['billing'] },
        { path: '/home/tester/GitLab/acme/claude', rel: 'acme/claude', name: 'claude', sessions: [] },
        { path: '/home/tester/GitLab/acme/console', rel: 'acme/console', name: 'console', sessions: ['console'] }
    ],
    other_sessions: ['scratch', 'my notes'],
    default_command: 'claude -n {repo}'
};
const THEIRS = {
    installed: true, login: 'alice', root: '/home/alice/GitLab',
    sessions: [{ name: 'site', attached: 0, windows: 1, created: now - 900, activity: now - 60, attachable: true, path: '/home/alice/GitLab/acme/site', command: 'claude', title: '✳ New landing page',
        claude: { state: 'ready', excerpt: ['● The page is ready to review.'] } }],
    repos: [{ path: '/home/alice/GitLab/acme/site', rel: 'acme/site', name: 'site', sessions: ['site'] }],
    other_sessions: []
};
const SHARED = { installed: true, login: 'root', root: '/root/GitLab', sessions: [{ name: 'upgrade', attached: 0, windows: 1, created: now - 900, activity: now - 90, attachable: true, path: '/root', command: 'bash' }], repos: [], other_sessions: ['upgrade'] };
const CONFIG = { workbench_host: BENCH, workbench_prefix: 'wb-', workbench_scope: 'shared', my_folder: MY };

async function setup(page, extra = {}) {
    const sends = [], starts = [];
    const api = await installApi(page, { folders: folders(), routes: {
        'GET /api/dashboard/config': CONFIG,
        [`GET ${url('staff')}/tmux/dashboard`]: SHARED,
        [`GET ${url('staff', 'web01')}/tmux/dashboard`]: { ...SHARED, sessions: [], other_sessions: [] },
        [`GET ${url(MY)}/tmux/dashboard`]: MINE,
        [`GET ${url(ALICE)}/tmux/dashboard`]: THEIRS,
        [`POST ${url(MY)}/tmux/send`]: (req) => { sends.push(req.postDataJSON()); return { sent: true }; },
        [`POST ${url(MY)}/tmux/start`]: (req) => { const b = req.postDataJSON(); starts.push(b); return { installed: true, no_base64: false, sessions: b.sessions.map(s => ({ name: s.name, state: 'created', commands_sent: false })) }; },
        ...extra
    } });
    return { api, sends, starts };
}
const asked = (api, f, e) => api.calls.filter(c => c.method === 'GET' && c.path === `${url(f, e)}/tmux/dashboard`).length;

test('shows only your own sessions by default, and puts what waits on you first', async ({ page }) => {
    const { api } = await setup(page);
    await page.goto('/dashboard.html');
    // Mine: your own work bench only. Not the shared logins, not Alice's
    // (an admin can open hers), not another host.
    await expect(page.locator('#view')).toBeVisible();
    await expect(page.locator('#view-mine')).toHaveAttribute('aria-pressed', 'true');
    const chips = page.locator('#hosts .chip');
    await expect(chips).toHaveCount(1);
    await expect(chips.first()).toContainText('Work Bench - tester@example.com');
    await expect.poll(() => asked(api, MY)).toBe(1);
    expect(asked(api, 'staff')).toBe(0);
    expect(asked(api, ALICE)).toBe(0);
    expect(asked(api, 'staff', 'web01')).toBe(0);

    const cards = page.locator('#waiting .card');
    await expect(cards).toHaveCount(2);
    // A prompt before a finished reply.
    await expect(cards.nth(0)).toContainText('console');
    await expect(cards.nth(0).locator('.badge')).toHaveText('Asking');
    await expect(cards.nth(0).locator('.excerpt')).toContainText('Do you want to proceed?');
    await expect(cards.nth(1)).toContainText('billing');
    await expect(cards.nth(1)).toContainText('Invoices for October');
    await expect(cards.nth(1)).toContainText('acme/billing');
    await expect(page.locator('#n-waiting')).toHaveText('(2)');
    await expect(page.locator('#working .row')).toHaveCount(1);
    await expect(page.locator('#working')).toContainText('deploy');
    await expect(page.locator('#other')).toContainText('scratch');
    await expect(page.locator('#repos .row')).toHaveCount(4);
    await expect(page.locator('#repos .row').filter({ hasText: 'acme/claude' }).locator('.rdot')).toHaveClass(/off/);
});

test('All users shows everyone you may open, says whose each session is, and is remembered', async ({ page }) => {
    const { api } = await setup(page);
    await page.goto('/dashboard.html');
    await expect(page.locator('#waiting .card')).toHaveCount(2);
    await page.locator('#view-all').click();
    await expect(page.locator('#view-all')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#hosts .chip')).toHaveCount(4);
    await expect.poll(() => asked(api, ALICE)).toBe(1);
    await expect.poll(() => asked(api, 'staff')).toBe(1);
    const cards = page.locator('#waiting .card');
    await expect(cards).toHaveCount(3);
    await expect(cards.filter({ hasText: 'New landing page' }).locator('.c-head')).toContainText('alice');
    await expect(cards.filter({ hasText: 'Invoices for October' }).locator('.c-head')).toContainText('tester');
    await expect(page.locator('#other .row').filter({ hasText: 'upgrade' })).toContainText('root');

    // One host switched off by hand stays off, in this view and after a reload.
    await page.locator('#hosts .chip').filter({ hasText: 'alice' }).click();
    await expect(cards).toHaveCount(2);
    await page.reload();
    await expect(page.locator('#view-all')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#hosts .chip')).toHaveCount(4);
    await expect(page.locator('#hosts .chip').filter({ hasText: 'alice' })).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#other .row').filter({ hasText: 'upgrade' })).toHaveCount(1);
    await expect(cards).toHaveCount(2);

    // Back to Mine: only your own again.
    await page.locator('#view-mine').click();
    await expect(page.locator('#hosts .chip')).toHaveCount(1);
    await expect(page.locator('#other .row').filter({ hasText: 'upgrade' })).toHaveCount(0);
    await expect(cards.nth(0).locator('.c-head')).not.toContainText('tester');
});

test('with nobody else to show there is no selector; without a work bench of your own, the shared logins are yours', async ({ page }) => {
    // Only your own folder is open to you.
    await installApi(page, { folders: [folders()[1]], routes: { 'GET /api/dashboard/config': CONFIG, [`GET ${url(MY)}/tmux/dashboard`]: MINE } });
    await page.goto('/dashboard.html');
    await expect(page.locator('#waiting .card')).toHaveCount(2);
    await expect(page.locator('#view')).toBeHidden();

    // No work bench folder of your own: the work bench host's shared login
    // counts as yours; other people's folders and other hosts do not.
    const api = await installApi(page, { folders: [folders()[0], folders()[2]], routes: {
        'GET /api/dashboard/config': CONFIG,
        [`GET ${url('staff')}/tmux/dashboard`]: SHARED,
        [`GET ${url(ALICE)}/tmux/dashboard`]: THEIRS
    } });
    await page.goto('/dashboard.html');
    await expect(page.locator('#other .row').filter({ hasText: 'upgrade' })).toHaveCount(1);
    await expect(page.locator('#hosts .chip')).toHaveCount(1);
    await expect(page.locator('#view')).toBeVisible();
    expect(asked(api, ALICE)).toBe(0);
});

test('one-tap choices, answers, and Open', async ({ page, context }) => {
    const { sends } = await setup(page);
    await page.goto('/dashboard.html');
    const asking = page.locator('#waiting .card').nth(0);
    const opts = asking.locator('.opts .btn');
    await expect(opts).toHaveCount(3);
    await expect(opts.nth(0)).toHaveText('1. Yes');
    await opts.nth(0).click();
    await expect.poll(() => sends.length).toBe(1);
    expect(sends[0]).toEqual({ session: 'console', text: '1', enter: false });

    const ready = page.locator('#waiting .card').nth(1);
    await ready.locator('input').fill('yes, send them');
    await ready.locator('input').press('Enter');
    await expect.poll(() => sends.length).toBe(2);
    expect(sends[1]).toEqual({ session: 'billing', text: 'yes, send them', enter: true });
    await expect(ready.locator('input')).toHaveValue('');

    const popup = context.waitForEvent('page');
    await ready.getByRole('button', { name: 'Open' }).click();
    const w = await popup;
    await expect.poll(() => w.url()).toContain(`/tmux.html?scope=shared&folder=${MY}&entry=${HOST}&protocol=ssh`);
    expect(w.url()).toContain('&s=billing&active=billing');
});

test('Open all opens every running session as tabs of the workspace, not the repos', async ({ page, context }) => {
    await setup(page);
    await page.goto('/dashboard.html');
    const btn = page.locator('#open-all');
    // The four sessions that can be attached; "my notes" cannot (its name),
    // and the repo without a session is not started.
    await expect(btn).toHaveText('Open all (4)');
    const popup = context.waitForEvent('page');
    await btn.click();
    const w = await popup;
    await expect.poll(() => w.url()).toContain(`/tmux.html?scope=shared&folder=${MY}&entry=${HOST}&protocol=ssh`);
    const s = new URL(w.url()).searchParams;
    expect(s.get('s').split(',').sort()).toEqual(['billing', 'console', 'deploy', 'scratch']);
    expect(s.get('active')).toBe('billing');
});

test('Open all waits for sessions to open', async ({ page }) => {
    await installApi(page, { folders: [folders()[1]], routes: { 'GET /api/dashboard/config': CONFIG, [`GET ${url(MY)}/tmux/dashboard`]: { ...MINE, sessions: [], other_sessions: [] } } });
    await page.goto('/dashboard.html');
    await expect(page.locator('#repos .row')).toHaveCount(4);
    await expect(page.locator('#open-all')).toBeDisabled();
    await expect(page.locator('#open-all')).toHaveText('Open all');
});

test('a black repo starts a session in its folder, with your command or the default', async ({ page, context }) => {
    const { starts } = await setup(page);
    await page.goto('/dashboard.html');
    await page.evaluate(() => localStorage.setItem('rg-tmux-repo-cmd', 'claude'));
    await page.locator('#repo-q').fill('claude');
    const row = page.locator('#repos .row');
    await expect(row).toHaveCount(1);
    const popup = context.waitForEvent('page');
    await row.getByRole('button', { name: 'Start' }).click();
    await expect.poll(() => starts.length).toBe(1);
    expect(starts[0].sessions).toEqual([{ name: 'claude', dir: '/home/tester/GitLab/acme/claude', commands: 'claude' }]);
    const w = await popup;
    await expect.poll(() => w.url()).toContain('&s=claude&active=claude');

    // Without a command of your own, the console's default runs, named
    // after the repo.
    await page.evaluate(() => localStorage.removeItem('rg-tmux-repo-cmd'));
    await page.reload();
    await page.locator('#repo-q').fill('claude');
    await page.locator('#repos .row').getByRole('button', { name: 'Start' }).click();
    await expect.poll(() => starts.length).toBe(2);
    expect(starts[1].sessions[0].commands).toBe('claude -n claude');
});

test('a host that cannot be asked says so, and the page fits a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setup(page, { [`GET ${url(ALICE)}/tmux/dashboard`]: { status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'the host could not be asked: timed out' }) } });
    await page.goto('/dashboard.html');
    await page.locator('#view-all').click();
    await expect(page.locator('#msg')).toContainText('timed out');
    await expect(page.locator('#waiting .card')).toHaveCount(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    const card = await page.locator('#waiting .card').nth(0).boundingBox();
    for (const b of await page.locator('#waiting .card').nth(0).locator('.opts .btn').all()) {
        const bb = await b.boundingBox();
        expect(bb.x + bb.width).toBeLessThanOrEqual(card.x + card.width);
    }
});
