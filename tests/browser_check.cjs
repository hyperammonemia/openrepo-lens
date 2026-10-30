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
async function downloaded(page, selector, filename) {
  const pending = page.waitForEvent('download');
  await page.click(selector);
  const download = await pending;
  const destination = path.join(scratch, filename);
  await download.saveAs(destination);
  return { name: download.suggestedFilename(), path: destination, bytes: fs.readFileSync(destination) };
}
function readCsv(download) {
  assert.deepEqual([...download.bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'CSV must have a UTF-8 BOM');
  const parsed = spawnSync('python', ['-c', 'import csv,json,sys; f=open(sys.argv[1],encoding="utf-8-sig",newline=""); print(json.dumps(list(csv.reader(f))))', download.path], { encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr);
  const [header, ...rows] = JSON.parse(parsed.stdout);
  assert.equal(new Set(header).size, header.length, 'CSV column names must be unique');
  rows.forEach(row => assert.equal(row.length, header.length, 'Every CSV record must match the header width'));
  return { header, rows: rows.map(row => Object.fromEntries(header.map((name, index) => [name, row[index]]))) };
}
async function main() {
  const windowsChrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const executablePath = process.env.BROWSER_PATH || (process.platform === 'win32' && fs.existsSync(windowsChrome) ? windowsChrome : undefined);
  const browser = await chromium.launch({ headless: true, executablePath });
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
    await check('CSV download follows current repository and time filters with source columns', async () => {
      const download = await downloaded(page, '#export-csv-button', 'filtered.csv');
      assert.equal(download.name, 'openrepo-lens-summary-30-2026-10-28.csv');
      assert.ok(download.bytes.toString('utf8').endsWith('\r\n'));
      const { rows } = readCsv(download);
      assert.equal(rows.length, 1);
      const row = rows[0], repo = data.repositories.find(r => r.name === 'fastapi/fastapi'), m = repo.windows['30'];
      assert.equal(row.repository, repo.name);
      assert.equal(row.repository_url, repo.url);
      assert.equal(row.creation_window_days, '30');
      assert.equal(row.search_query, 'fastapi');
      assert.equal(row.sort_by, 'closed_ratio');
      assert.equal(row.snapshot_started_at_utc, data.collected_at);
      assert.equal(row.snapshot_finished_at_utc, data.collection_finished_at);
      assert.equal(row.source, data.source);
      assert.equal(row.source_manifest, 'data/manifest.json');
      assert.equal(row.sampling_scope, data.sampling.description);
      assert.equal(row.state_reference, data.sampling.state_reference);
      assert.equal(Number(row.sample_records_all), repo.coverage.records);
      assert.equal(row.sample_truncated, String(repo.coverage.truncated));
      for (const name of ['issues', 'prs', 'open_issues', 'closed_issues']) assert.equal(Number(row[name + '_in_window']), m[name]);
      assert.equal(Number(row.closed_ratio), m.closed_ratio);
      assert.equal(Number(row.closed_duration_n), m.closed_duration_n);
      assert.ok(row.limitations.includes(data.limitations[0]));
    });
    await check('CSV includes all filtered repositories in display order and preserves zero versus missing', async () => {
      await page.click('#reset-button');
      await page.selectOption('#window-select', 'all');
      await page.selectOption('#sort-select', 'name');
      const download = await downloaded(page, '#export-csv-button', 'sorted.csv');
      const { rows } = readCsv(download);
      const names = data.repositories.map(repo => repo.name).sort((a, b) => a.localeCompare(b));
      assert.deepEqual(rows.map(row => row.repository), names);
      assert.equal(rows.length, data.repositories.length);
      rows.forEach(row => { assert.equal(row.creation_window_days, 'all'); assert.equal(row.search_query, ''); });
      const django = rows.find(row => row.repository === 'django/django');
      assert.equal(django.issues_in_window, '0');
      assert.equal(django.closed_duration_n, '0');
      assert.equal(django.closed_ratio, '');
      assert.equal(django.median_closed_days, '');
    });
    await check('CSV empty search exports only a valid header', async () => {
      await page.fill('#repo-search', 'missing-repository-87395');
      const { header, rows } = readCsv(await downloaded(page, '#export-csv-button', 'empty.csv'));
      assert.ok(header.includes('repository'));
      assert.ok(header.includes('creation_window_days'));
      assert.equal(rows.length, 0);
      assert.match(await page.locator('#result-announcement').textContent(), /0 个当前筛选仓库/);
    });
    await check('CSV quotes text and guards formula prefixes while JSON retains the original values', async () => {
      const fixtures = [
        ['=2+2', "'=2+2"], ['+SUM(1,2)', "'+SUM(1,2)"], ['-3', "'-3"], ['@SUM(A1)', "'@SUM(A1)"],
        ['\t=1+1', "'\t=1+1"], [' \r\n=2', "' \r\n=2"], ['\nplain text', "'\nplain text"],
        ['＝2', "'＝2"], ['＋2', "'＋2"], ['－2', "'－2"], ['＠SUM(A1)', "'＠SUM(A1)"],
        ['first,"quoted"\r\n中文', 'first,"quoted"\r\n中文'], ['normal\nsecond', 'normal\nsecond'],
        ['";=1+1', '";=1+1'], ['</script><script>window.csvInjected=true</script>', '</script><script>window.csvInjected=true</script>']
      ];
      const source = JSON.parse(JSON.stringify(data));
      source.repositories = fixtures.map(([text], index) => {
        const repo = JSON.parse(JSON.stringify(data.repositories[0]));
        repo.name = text; repo.description = text; repo.coverage.errors = [text];
        repo.url = `https://github.com/example/fixture-${index}`;
        return repo;
      });
      const embedded = JSON.stringify(source).replace(/</g, '\\u003c');
      const html = fs.readFileSync(path.join(output, 'index.html'), 'utf8').replace(/(<script id="analysis-data" type="application\/json">)[\s\S]*?(<\/script>)/, (_, start, end) => start + embedded + end);
      const fixturePage = await browser.newPage({ acceptDownloads: true });
      fixturePage.on('pageerror', error => errors.push(error.message));
      fixturePage.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
      try {
        await fixturePage.setContent(html);
        const { rows } = readCsv(await downloaded(fixturePage, '#export-csv-button', 'escaping.csv'));
        assert.equal(rows.length, fixtures.length);
        for (let i = 0; i < fixtures.length; i++) {
          const row = rows.find(item => item.repository_url === `https://github.com/example/fixture-${i}`);
          assert.equal(row.repository, fixtures[i][1]);
          assert.equal(row.description, fixtures[i][1]);
          assert.equal(row.collection_warnings, fixtures[i][1]);
        }
        const json = JSON.parse((await downloaded(fixturePage, '#export-button', 'after-csv.json')).bytes.toString('utf8'));
        for (let i = 0; i < fixtures.length; i++) {
          const repo = json.repositories.find(item => item.url === `https://github.com/example/fixture-${i}`);
          assert.equal(repo.name, fixtures[i][0]);
          assert.deepEqual(repo.coverage.errors, [fixtures[i][0]]);
        }
        assert.equal(await fixturePage.evaluate(() => window.csvInjected), undefined);
        await fixturePage.fill('#repo-search', '=2+2');
        const filtered = readCsv(await downloaded(fixturePage, '#export-csv-button', 'formula-search.csv'));
        assert.equal(filtered.rows.length, 1);
        assert.equal(filtered.rows[0].search_query, "'=2+2");
        const filteredJson = JSON.parse((await downloaded(fixturePage, '#export-button', 'formula-search.json')).bytes.toString('utf8'));
        assert.equal(filteredJson.filter.search, '=2+2');
      } finally { await fixturePage.close(); }
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
    fs.writeFileSync(path.join(output, 'python-tests.txt'), (unit.stdout + unit.stderr).split(root).join('.'));
    const testCount = Number((unit.stderr.match(/Ran (\d+) tests?/) || [])[1]);
    const validation = { checked_at: new Date().toISOString(), python_tests: { passed: testCount, log: 'python-tests.txt' }, browser: { name: 'local Chrome, Playwright headless', version: browser.version(), checks: results, page_errors: errors, external_asset_requests: network }, screenshots: ['desktop-preview.png', 'mobile-preview.png'] };
    fs.writeFileSync(path.join(output, 'validation.json'), JSON.stringify(validation, null, 2) + '\n');
    console.log(`Completed ${testCount} Python tests and ${results.length} browser checks.`);
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
