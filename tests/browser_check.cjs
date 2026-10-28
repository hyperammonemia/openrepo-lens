'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { pathToFileURL } = require('url');
const { spawnSync } = require('child_process');
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require('../.qa/node_modules/playwright')); }
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output');
const scratch = path.join(root, '.qa', 'tmp');
fs.mkdirSync(scratch, { recursive: true });
process.env.TMP = scratch;
process.env.TEMP = scratch;
const data = JSON.parse(fs.readFileSync(path.join(output, 'analysis.json'), 'utf8'));
const results = [];
async function check(name, task) {
  await task(); results.push({ name, passed: true }); console.log('PASS ' + name);
}
async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
  const errors = [], network = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
    await page.goto(pathToFileURL(path.join(output, 'index.html')).href);
    await check('desktop loads five real repositories offline', async () => {
      assert.equal(await page.locator('.compare-row').count(), data.repositories.length);
      assert.match(await page.title(), /OpenRepo Lens/);
      assert.equal(await page.locator('#snapshot-total').textContent(), '5 个仓库 · 1,000 条去重后记录');
      assert.equal(network.length, 0);
    });
    await check('time windows reconcile with analysis JSON', async () => {
      for (const period of ['30', 'all', '90']) {
        await page.selectOption('#window-select', period);
        const values = await page.locator('#summary .stat-value').allTextContents();
        const sum = key => data.repositories.reduce((n, repo) => n + repo.windows[period][key], 0);
        assert.equal(Number(values[1].replaceAll(',', '')), sum('issues'));
        assert.equal(Number(values[2].replaceAll(',', '')), sum('prs'));
      }
    });
    await check('search and repository detail selection', async () => {
      await page.fill('#repo-search', 'FASTAPI');
      assert.equal(await page.locator('.compare-row').count(), 1);
      assert.equal(await page.locator('#repo-detail h2').textContent(), 'fastapi/fastapi');
      await page.click('#reset-button');
      await page.getByRole('button', { name: /^django\/django：/ }).click();
      assert.match(await page.locator('#repo-detail').textContent(), /GitHub Issues 未启用/);
      assert.match(await page.locator('#issue-list').textContent(), /没有 Issue 样本/);
      assert.equal(await page.locator('.compare-row.selected .ratio').textContent(), '—');
    });
    await check('keyboard selection preserves focus', async () => {
      const button = page.getByRole('button', { name: /^pallets\/flask：/ });
      await button.focus(); await page.keyboard.press('Enter');
      assert.equal(await page.locator('.compare-row.selected').evaluate(el => el === document.activeElement), true);
      assert.equal(await page.locator('#repo-detail h2').textContent(), 'pallets/flask');
    });
    await check('search empty state and reset', async () => {
      await page.fill('#repo-search', 'missing-repository-87395');
      assert.equal(await page.locator('.compare-row').count(), 0);
      assert.match(await page.locator('#comparison').textContent(), /未找到匹配仓库/);
      assert.match(await page.locator('#repo-detail').textContent(), /没有可展示/);
      await page.click('#reset-button');
      assert.equal(await page.locator('.compare-row').count(), 5);
    });
    await check('sort handles null ratios last', async () => {
      await page.selectOption('#sort-select', 'closed_ratio');
      const values = await page.locator('.compare-row .ratio').allTextContents();
      assert.equal(values.at(-1), '—');
      const nums = values.filter(x => x !== '—').map(parseFloat);
      assert.deepEqual(nums, [...nums].sort((a, b) => b - a));
    });
    await check('download matches active filter and metric window', async () => {
      await page.fill('#repo-search', 'fastapi');
      await page.selectOption('#window-select', '30');
      const pending = page.waitForEvent('download');
      await page.click('#export-button');
      const download = await pending;
      const filename = path.join(scratch, 'export.json');
      await download.saveAs(filename);
      const payload = JSON.parse(fs.readFileSync(filename, 'utf8'));
      assert.equal(payload.filter.creation_window, '30');
      assert.equal(payload.repositories.length, 1);
      assert.equal(payload.repositories[0].name, 'fastapi/fastapi');
      assert.deepEqual(payload.repositories[0].metrics, data.repositories.find(r => r.name === 'fastapi/fastapi').windows['30']);
    });
    await page.click('#reset-button');
    await page.screenshot({ path: path.join(output, 'desktop-preview.png'), fullPage: false });
    await check('mobile layout fits 390px and 320px', async () => {
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 1000 });
        const sizes = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
        assert.ok(sizes.scroll <= sizes.client, `Horizontal overflow: ${JSON.stringify(sizes)}`);
        await page.fill('#repo-search', 'sanic');
        assert.equal(await page.locator('.compare-row').count(), 1);
        await page.click('#reset-button');
      }
      await page.setViewportSize({ width: 390, height: 1000 });
      await page.screenshot({ path: path.join(output, 'mobile-preview.png'), fullPage: true });
    });
    await check('no runtime errors or external asset requests', async () => {
      assert.deepEqual(errors, []); assert.deepEqual(network, []);
    });
    const unit = spawnSync('python', ['-m', 'unittest', 'discover', '-s', 'tests', '-v'], { cwd: root, encoding: 'utf8' });
    assert.equal(unit.status, 0, unit.stdout + unit.stderr);
    fs.writeFileSync(path.join(output, 'python-tests.txt'), unit.stdout + unit.stderr);
    const testCount = Number((unit.stderr.match(/Ran (\d+) tests?/) || [])[1]);
    const validation = { checked_at: new Date().toISOString(), python_tests: { passed: testCount, log: 'python-tests.txt' }, browser: { name: 'local Chrome, Playwright headless', version: browser.version(), checks: results, page_errors: errors, external_asset_requests: network }, screenshots: ['desktop-preview.png', 'mobile-preview.png'] };
    fs.writeFileSync(path.join(output, 'validation.json'), JSON.stringify(validation, null, 2) + '\n');
    console.log(`Completed ${testCount} Python tests and ${results.length} browser checks.`);
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
