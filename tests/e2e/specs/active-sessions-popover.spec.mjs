// #333: Active Sessions is a button in the nav that opens a panel over the
// page, instead of a strip that pushed the folders and entries down.
// #334: the panel's Terminate all ends every session it lists.
import { test, expect } from '@playwright/test';
import { installApi, settle } from '../lib/api.mjs';

function sess(i, type = 'ssh') {
    return {
        session_id: `0000000${i}-1111-4111-8111-111111111111`, session_type: type, status: 'active',
        client_url: `/client/${i}`, hostname: `host${i}.acme.internal`, entry_display_name: `host-${i}`,
        username: 'root', active_connections: 1, created_by: 'tester@example.com'
    };
}
const many = () => [1, 2, 3, 4, 5, 6, 7].map(i => sess(i, i % 2 ? 'ssh' : 'rdp'));

// Sessions the test can end: GET lists what is left, DELETE removes one
// (or answers `deleteStatus[id]` instead).
function liveSessions(list, deleteStatus = {}) {
    const routes = { 'GET /api/sessions': () => list };
    for (const s of [...list]) {
        routes[`DELETE /api/sessions/${s.session_id}`] = () => {
            const st = deleteStatus[s.session_id];
            if (st) return { status: st, body: 'refused' };
            list.splice(list.findIndex(x => x.session_id === s.session_id), 1);
            return { ok: true };
        };
    }
    return routes;
}

async function layoutTop(page) {
    return page.locator('.layout').evaluate(el => el.getBoundingClientRect().top);
}

test('sessions never push the page down; the button shows the count', async ({ page }) => {
    await installApi(page, { sessions: [] });
    await page.goto('/connections.html');
    await settle(page);
    await expect(page.locator('#as-wrap')).toBeHidden();
    const without = await layoutTop(page);

    const page2 = await page.context().newPage();
    await installApi(page2, { sessions: many() });
    await page2.goto('/connections.html');
    await settle(page2);
    await expect(page2.locator('#as-btn')).toBeVisible();
    await expect(page2.locator('#active-sessions-count')).toHaveText('7');
    await expect(page2.locator('#active-sessions')).toBeHidden();
    expect(await layoutTop(page2)).toBe(without);
});

test('the panel opens downwards over the page, with the cards in a scrolling row', async ({ page }) => {
    await installApi(page, { sessions: many() });
    await page.goto('/connections.html');
    await settle(page);
    const before = await layoutTop(page);
    await page.click('#as-btn');
    const panel = page.locator('#active-sessions');
    await expect(panel).toBeVisible();
    await expect(page.locator('#as-btn')).toHaveAttribute('aria-expanded', 'true');
    await expect(panel.locator('.session-card')).toHaveCount(7);
    const m = await page.evaluate(() => {
        const p = document.getElementById('active-sessions').getBoundingClientRect();
        const b = document.getElementById('as-btn').getBoundingClientRect();
        const nav = document.querySelector('nav').getBoundingClientRect();
        const grid = document.getElementById('active-sessions-grid');
        return { pTop: p.top, pBottom: p.bottom, pLeft: p.left, pRight: p.right, bBottom: b.bottom,
            navLeft: nav.left, navRight: nav.right, vh: innerHeight,
            position: getComputedStyle(document.getElementById('active-sessions')).position,
            scrolls: grid.scrollWidth > grid.clientWidth, overflowX: getComputedStyle(grid).overflowX };
    });
    expect(m.position).toBe('fixed');
    expect(m.pTop).toBeGreaterThan(m.bBottom);
    expect(m.pBottom).toBeLessThanOrEqual(m.vh);
    expect(Math.abs(m.pLeft - m.navLeft)).toBeLessThanOrEqual(1);
    expect(Math.abs(m.pRight - m.navRight)).toBeLessThanOrEqual(1);
    expect(m.overflowX).toBe('auto');
    expect(m.scrolls, 'seven cards overflow the row').toBe(true);
    expect(await layoutTop(page), 'nothing beneath moved').toBe(before);
});

test('the close button, Escape and a click elsewhere close it; a click inside does not', async ({ page }) => {
    await installApi(page, { sessions: many() });
    await page.goto('/connections.html');
    await settle(page);
    const panel = page.locator('#active-sessions');

    await page.click('#as-btn');
    await panel.locator('.section-head strong').click();
    await expect(panel).toBeVisible();
    await page.click('#as-close');
    await expect(panel).toBeHidden();
    await expect(page.locator('#as-btn')).toBeFocused();
    await expect(page.locator('#as-btn')).toHaveAttribute('aria-expanded', 'false');

    await page.click('#as-btn');
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(page.locator('#as-btn')).toBeFocused();

    await page.click('#as-btn');
    await page.mouse.click(900, 1000);
    await expect(panel).toBeHidden();

    // The button toggles it.
    await page.click('#as-btn');
    await expect(panel).toBeVisible();
    await page.click('#as-btn');
    await expect(panel).toBeHidden();
});

test('a Terminate confirmation over the panel keeps it open, and Escape there is the dialog\'s', async ({ page }) => {
    await installApi(page, { sessions: many() });
    await page.goto('/connections.html');
    await settle(page);
    const panel = page.locator('#active-sessions');
    await page.click('#as-btn');
    await panel.locator('[data-terminate]').first().click();
    await expect(page.locator('#rg-dialog-overlay.open')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#rg-dialog-overlay.open')).toHaveCount(0);
    await expect(panel).toBeVisible();
    await panel.locator('[data-terminate]').first().click();
    await page.locator('#rg-dialog-overlay button', { hasText: 'Cancel' }).click();
    await expect(panel).toBeVisible();
});

test('Terminate all ends every listed session after one confirmation', async ({ page }) => {
    const list = many();
    const api = await installApi(page, { sessions: list, routes: liveSessions(list) });
    await page.goto('/connections.html');
    await settle(page);
    await page.click('#as-btn');
    await page.click('#as-terminate-all');
    await expect(page.locator('#rg-dialog-message')).toHaveText(/Terminate all 7 of your active sessions\? Any unsaved work in them will be lost\./);
    await page.locator('#rg-dialog-overlay button', { hasText: 'Terminate all' }).click();
    await expect(page.locator('#as-wrap')).toBeHidden();
    await expect(page.locator('#active-sessions')).toBeHidden();
    const deleted = api.calls.filter(c => c.method === 'DELETE').map(c => c.path).sort();
    expect(deleted).toEqual(many().map(s => `/api/sessions/${s.session_id}`).sort());
});

test('Terminate all cancelled ends nothing', async ({ page }) => {
    const list = many();
    const api = await installApi(page, { sessions: list, routes: liveSessions(list) });
    await page.goto('/connections.html');
    await settle(page);
    await page.click('#as-btn');
    await page.click('#as-terminate-all');
    await page.locator('#rg-dialog-overlay button', { hasText: 'Cancel' }).click();
    expect(api.calls.filter(c => c.method === 'DELETE')).toHaveLength(0);
    await expect(page.locator('#active-sessions .session-card')).toHaveCount(7);
});

test('Terminate all says which sessions it could not end, and counts gone ones as ended', async ({ page }) => {
    const list = many();
    const routes = liveSessions(list, {
        [sess(2).session_id]: 500,
        [sess(3).session_id]: 404
    });
    await installApi(page, { sessions: list, routes });
    await page.goto('/connections.html');
    await settle(page);
    await page.click('#as-btn');
    await page.click('#as-terminate-all');
    await page.locator('#rg-dialog-overlay button', { hasText: 'Terminate all' }).click();
    await expect(page.locator('#global-error')).toContainText('Could not terminate 1 of 7 sessions: host-2: refused');
    await expect(page.locator('#as-terminate-all')).toHaveText('Terminate all');
    await expect(page.locator('#as-terminate-all')).toBeEnabled();
});

test('the refresh keeps the row where it was scrolled', async ({ page }) => {
    await installApi(page, { sessions: many() });
    await page.goto('/connections.html');
    await settle(page);
    await page.click('#as-btn');
    const grid = page.locator('#active-sessions-grid');
    await grid.evaluate(el => { el.scrollLeft = 400; });
    await page.evaluate(() => loadActiveSessions());
    await page.waitForTimeout(300);
    expect(await grid.evaluate(el => el.scrollLeft)).toBe(400);
    await expect(page.locator('#active-sessions')).toBeVisible();
});

test('on a phone the panel stays inside the screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installApi(page, { sessions: many() });
    await page.goto('/connections.html');
    await settle(page);
    await page.click('#as-btn');
    const m = await page.locator('#active-sessions').evaluate(el => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, vw: document.documentElement.clientWidth };
    });
    expect(m.left).toBeGreaterThanOrEqual(0);
    expect(m.right).toBeLessThanOrEqual(m.vw);
});

test('the row leaves room under the cards for its scrollbar', async ({ page }) => {
    await installApi(page, { sessions: many() });
    await page.goto('/connections.html');
    await settle(page);
    await page.click('#as-btn');
    const gap = await page.evaluate(() => {
        const grid = document.getElementById('active-sessions-grid');
        const card = grid.querySelector('.session-card').getBoundingClientRect();
        return grid.getBoundingClientRect().bottom - card.bottom;
    });
    expect(gap, 'px between the cards and the bottom of the row').toBeGreaterThanOrEqual(16);
});
