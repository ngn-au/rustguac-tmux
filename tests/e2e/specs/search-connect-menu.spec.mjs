// The global search's results have the connections page's Connect menu
// (connect-menu.js): every protocol of an entry (#296), and the tmux
// sessions of an SSH protocol with tmux on (#325). On another page,
// credentials typed at connect and the Advanced dialog are on the
// connections page, so they go there; on the connections page they open in
// place.
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
    return [
        folder('acme', { entries: [tmuxSsh('build01'), entry('plain01', 'ssh'), mixed(), tmuxSsh('prompt01', { fields: { prompt_credentials: true } })] }),
        folder('other', { entries: [entry('elsewhere01', 'ssh')] })
    ];
}
const now = Math.floor(Date.now() / 1000);
const LISTING = { installed: true, sessions: [
    { name: 'deploy', attached: 1, windows: 3, created: now - 7200, activity: now - 120, attachable: true },
    { name: 'logs', attached: 0, windows: 1, created: now - 9000, activity: now - 4000, attachable: true }
] };
const BUILD = '/api/addressbook/folders/shared/acme/entries/build01';
const SRV = '/api/addressbook/folders/shared/acme/entries/srv02';

async function search(page, path, q) {
    await page.goto(path);
    await settle(page);
    await page.locator('#rg-search').click();
    await page.keyboard.type(q);
    await expect(page.locator('#search-results tbody tr')).toHaveCount(1);
    return page.locator('#search-results tbody tr').first();
}

test('a result with several protocols has the menu, and a pick connects with that protocol', async ({ page }) => {
    const api = await installApi(page, { folders: folders(), routes: { [`GET ${SRV}/tmux`]: LISTING } });
    const r = await search(page, '/sessions.html', 'srv02');
    await r.locator('[data-proto-toggle]').click();
    const menu = r.locator('.proto-menu-list');
    await expect(menu).toBeVisible();
    const protos = menu.locator('[data-sc-connect][data-protocol]');
    await expect(protos).toHaveCount(2);
    await expect(protos.nth(0)).toContainText('RDP');
    await expect(protos.nth(0)).toContainText('default');
    await expect(protos.nth(1)).toContainText('ssh-2222');
    await expect(protos.nth(1)).toContainText(':2222');
    // tmux for the SSH protocol that has it, asked of the host.
    await expect(menu.locator('.tmux-head')).toContainText('ssh-2222');
    await expect(menu.locator('[data-tmux-open="deploy"]')).toBeVisible();
    expect(api.calls.find(c => c.path === `${SRV}/tmux`).query.protocol).toBe('ssh-2222');

    await protos.nth(1).click();
    await expect(menu).toBeHidden();
    await expect.poll(() => api.calls.find(c => c.method === 'POST' && c.path === `${SRV}/connect`)?.body?.protocol).toBe('ssh-2222');
});

test('a plain result has no menu', async ({ page }) => {
    await installApi(page, { folders: folders() });
    const r = await search(page, '/recordings.html', 'plain01');
    await expect(r.locator('[data-sc-connect]').first()).toBeVisible();
    await expect(r.locator('[data-proto-toggle]')).toHaveCount(0);
});

test('a tmux session from a result opens in the workspace', async ({ page }) => {
    await installApi(page, { folders: folders(), routes: { [`GET ${BUILD}/tmux`]: LISTING } });
    await page.route('**/tmux.html*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>ws</title>' }));
    const r = await search(page, '/reports.html', 'build01');
    await r.locator('[data-proto-toggle]').click();
    const [ws] = await Promise.all([
        page.waitForEvent('popup'),
        r.locator('[data-tmux-open="deploy"]').click()
    ]);
    await ws.waitForURL(/\/tmux\.html/);
    const u = new URL(ws.url());
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ scope: 'shared', folder: 'acme', entry: 'build01', protocol: 'ssh', s: 'deploy', host: '10.0.0.30' });
});

test('Escape closes the menu first, then the overlay', async ({ page }) => {
    await installApi(page, { folders: folders(), routes: { [`GET ${BUILD}/tmux`]: LISTING } });
    const r = await search(page, '/sessions.html', 'build01');
    await r.locator('[data-proto-toggle]').click();
    const menu = r.locator('.proto-menu-list');
    await expect(menu.locator('[data-tmux-open="deploy"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(page.locator('#search-overlay')).toHaveClass(/open/);
    await page.keyboard.press('Escape');
    await expect(page.locator('#search-overlay')).not.toHaveClass(/open/);
});

test('on another page, Advanced opens the dialog for that connection on the connections page', async ({ page }) => {
    await installApi(page, { folders: folders(), routes: {
        [`GET ${BUILD}/tmux`]: LISTING,
        [`GET ${BUILD}/tmux/presets`]: { presets: [{ name: 'morning', sessions: [{ name: 'deploy', dir: '', commands: '' }] }] }
    } });
    const r = await search(page, '/sessions.html', 'build01');
    await r.locator('[data-proto-toggle]').click();
    await expect(r.locator('[data-tmux-preset="0"]')).toContainText('morning');
    await r.locator('[data-tmux-advanced]').click();
    await page.waitForURL(/\/connections\.html/);
    await expect(page.locator('#entries-title')).toHaveText('acme');
    await expect(page.locator('#tmux-start-modal')).toHaveClass(/active/);
    await expect(page.locator('#ts-target')).toContainText('10.0.0.30 :22');
    // With the connection's saved starts.
    await expect(page.locator('#ts-preset option')).toHaveText(['New (not saved)', 'morning (1)']);
    // The hash is spent: a reload does not open it again.
    expect(new URL(page.url()).hash).toBe('');
});

test('on another page, a tmux session on typed-in credentials goes to its folder', async ({ page }) => {
    await installApi(page, { folders: folders() });
    const r = await search(page, '/sessions.html', 'prompt01');
    await r.locator('[data-proto-toggle]').click();
    await expect(r.locator('.tmux-msg')).toContainText('typed at connect');
    await expect(r.locator('[data-tmux-advanced]')).toHaveCount(0);
    await r.locator('.tmux-new input').fill('work');
    await r.locator('.tmux-new input').press('Enter');
    await page.waitForURL(/\/connections\.html/);
    await expect(page.locator('#entries-title')).toHaveText('acme');
});

test('on the connections page, Advanced and typed-in credentials open in place', async ({ page }) => {
    await installApi(page, { folders: folders(), routes: { [`GET ${BUILD}/tmux`]: LISTING } });
    await page.goto('/connections.html');
    await settle(page);
    // Another folder is open underneath.
    await page.locator('.folder-row').filter({ hasText: /other/ }).first().click();
    await expect(page.locator('#entries-title')).toHaveText('other');

    await page.locator('#rg-search').click();
    await page.keyboard.type('build01');
    let r = page.locator('#search-results tbody tr').first();
    await r.locator('[data-proto-toggle]').click();
    await r.locator('[data-tmux-advanced]').click();
    await expect(page.locator('#search-overlay')).not.toHaveClass(/open/);
    await expect(page.locator('#tmux-start-modal')).toHaveClass(/active/);
    await expect(page.locator('#ts-target')).toContainText('build01');
    await expect(page.locator('#entries-title')).toHaveText('other');
    await page.locator('#ts-cancel').click();

    await page.locator('#rg-search').click();
    await page.locator('#rg-search').fill('prompt01');
    r = page.locator('#search-results tbody tr').first();
    await r.locator('[data-proto-toggle]').click();
    await r.locator('.tmux-new input').fill('work');
    await r.locator('.tmux-new input').press('Enter');
    await expect(page.locator('#search-overlay')).not.toHaveClass(/open/);
    await expect(page.locator('#cred-modal')).toHaveClass(/active/);
    await expect(page.locator('#cred-modal-title')).toContainText('prompt01');
});
