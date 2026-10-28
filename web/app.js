(() => {
  'use strict';
  const data = JSON.parse(document.getElementById('analysis-data').textContent);
  const repositories = Array.isArray(data.repositories) ? data.repositories : [];
  const $ = id => document.getElementById(id);
  const state = { window: '90', query: '', sort: 'issues', selected: null };
  const number = value => typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat('zh-CN').format(value) : '—';
  const days = value => typeof value === 'number' && Number.isFinite(value) ? (value > 0 && value < 1 ? (value < 0.0001 ? '<0.0001' : String(Number(value.toFixed(4)))) : value.toFixed(1)) : '—';
  const percent = value => typeof value === 'number' && Number.isFinite(value) ? (value * 100).toFixed(1) + '%' : '—';
  const date = value => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString().slice(0, 10) : '—';
  const emptyMetrics = { issues: 0, prs: 0, closed_issues: 0, open_issues: 0, closed_ratio: null, median_closed_days: null, median_open_age_days: null, oldest_open_days: null, monthly: [], recent_issues: [] };
  const metrics = repo => repo.windows?.[state.window] || emptyMetrics;
  function node(tag, cls, text) { const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = String(text); return el; }
  function safeLink(label, url, cls) {
    let parsed;
    try { parsed = new URL(url); } catch { return node('span', cls, label); }
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.username || parsed.password) return node('span', cls, label);
    const link = node('a', cls, label); link.href = parsed.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; return link;
  }
  function filtered() {
    const query = state.query.trim().toLocaleLowerCase();
    return repositories.filter(repo => !query || [repo.name, repo.description, repo.language].join(' ').toLocaleLowerCase().includes(query)).sort((a, b) => {
      if (state.sort === 'name') return a.name.localeCompare(b.name);
      const av = metrics(a)[state.sort], bv = metrics(b)[state.sort];
      if (av == null && bv == null) return a.name.localeCompare(b.name);
      if (av == null) return 1; if (bv == null) return -1;
      return bv - av || a.name.localeCompare(b.name);
    });
  }
  function stat(label, value, note) { const el = node('div', 'stat'); el.append(node('div', 'stat-label', label), node('div', 'stat-value', value), node('div', 'stat-note', note)); return el; }
  function renderSummary(list) {
    const issueCount = list.reduce((sum, repo) => sum + metrics(repo).issues, 0);
    const prCount = list.reduce((sum, repo) => sum + metrics(repo).prs, 0);
    const closed = list.reduce((sum, repo) => sum + metrics(repo).closed_issues, 0);
    $('summary').replaceChildren(stat('当前仓库', number(list.length), '独立展示各仓库采样边界'), stat('Issue 样本', number(issueCount), '当前创建时间范围内'), stat('Pull Request 样本', number(prCount), '与 Issue 分开计数'), stat('样本已关闭占比', percent(issueCount ? closed / issueCount : null), `${number(closed)} / ${number(issueCount)} 条 Issue`));
    $('result-announcement').textContent = `当前显示 ${list.length} 个仓库，${issueCount} 条 Issue，${prCount} 条 Pull Request。`;
  }
  function renderComparison(list) {
    const container = $('comparison'); container.replaceChildren();
    if (!list.length) { container.append(node('div', 'empty-state', '未找到匹配仓库。请调整关键词或重置筛选。')); return; }
    const head = node('div', 'compare-head'); ['仓库', 'Issue / PR 构成', '记录', '关闭占比'].forEach(label => head.append(node('span', '', label))); container.append(head);
    const maximum = Math.max(1, ...list.map(repo => metrics(repo).issues + metrics(repo).prs));
    list.forEach(repo => {
      const m = metrics(repo), row = node('button', 'compare-row' + (state.selected === repo.name ? ' selected' : ''));
      row.type = 'button'; row.setAttribute('aria-pressed', String(state.selected === repo.name));
      row.setAttribute('aria-label', `${repo.name}：${m.issues} 条 Issue，${m.prs} 条 PR，样本已关闭占比 ${percent(m.closed_ratio)}。查看明细`);
      const parts = repo.name.split('/'), name = node('span', 'repo-name', parts.slice(1).join('/') || parts[0]); name.append(node('span', 'repo-owner', parts[0]));
      const track = node('span', 'bar-track'); track.setAttribute('aria-hidden', 'true');
      const issue = node('span', 'bar-issue'), pr = node('span', 'bar-pr'); issue.style.width = `${m.issues / maximum * 100}%`; pr.style.width = `${m.prs / maximum * 100}%`; track.append(issue, pr);
      row.append(name, track, node('span', 'compare-number', number(m.issues + m.prs)), node('span', 'compare-number ratio', percent(m.closed_ratio)));
      row.addEventListener('click', () => { state.selected = repo.name; renderComparison(list); renderDetail(repo); container.querySelector('.compare-row[aria-pressed="true"]')?.focus({ preventScroll: true }); $('result-announcement').textContent = `已选择 ${repo.name}，下方展示该仓库的样本详情。`; }); container.append(row);
    });
    container.append(node('p', 'comparison-foot', '关闭占比仅使用 Issue 作为分母；仓库排序不代表质量排名。'));
  }
  function detailNumber(label, value, unit) { const cell = node('div'); cell.append(node('span', 'detail-number-label', label)); const valueEl = node('span', 'detail-number-value', value); if (unit) valueEl.append(node('small', '', unit)); cell.append(valueEl); return cell; }
  function renderDetail(repo) {
    const container = $('repo-detail'); container.replaceChildren();
    $('monthly-chart').replaceChildren(); $('issue-list').replaceChildren(); $('issue-count').textContent = '';
    if (!repo) { container.append(node('div', 'empty-state', '没有可展示的仓库。')); $('monthly-chart').append(node('div', 'empty-state', '暂无样本')); $('issue-list').append(node('div', 'empty-state', '暂无 Issue 样本')); return; }
    const m = metrics(repo), title = node('div', 'repo-title'), heading = node('h2'); heading.append(safeLink(repo.name, repo.url)); title.append(heading); if (repo.archived) title.append(node('span', 'quiet-tag', '已归档')); if (repo.has_issues === false) title.append(node('span', 'quiet-tag', 'GitHub Issues 未启用')); container.append(title);
    container.append(node('p', 'repo-description', repo.description || '仓库未提供描述。'));
    const meta = node('div', 'repo-meta'); [repo.language || '语言未标注', `${number(repo.stars)} Stars`, `${number(repo.forks)} Forks`].forEach(text => meta.append(node('span', 'quiet-tag', text))); container.append(meta);
    const values = node('div', 'detail-numbers'); values.append(detailNumber('样本中未关闭 Issue', number(m.open_issues), '条'), detailNumber('未关闭年龄中位数', days(m.median_open_age_days), '天'), detailNumber('已关闭耗时中位数', days(m.median_closed_days), '天'), detailNumber('最久未关闭样本年龄', days(m.oldest_open_days), '天')); container.append(values);
    const release = node('p', 'release-note', '发布列表首条：');
    if (repo.latest_release) { release.append(safeLink(repo.latest_release.tag || '查看发布', repo.latest_release.url), document.createTextNode(` · ${date(repo.latest_release.published_at)}${repo.latest_release.prerelease ? ' · 预发布' : ''}`)); } else { release.append(document.createTextNode('未取得发布记录')); } container.append(release);
    container.append(node('p', 'release-note', `关闭耗时有效样本 n = ${number(m.closed_duration_n ?? m.closed_issues)}${repo.has_issues === false ? '；GitHub Issues 未启用，零样本不代表维护质量。' : '；仅针对已关闭且时间有效的 Issue。'}`));
    container.append(node('p', 'release-note', `最近推送：${date(repo.pushed_at)} · 许可证：${typeof repo.license === 'string' ? repo.license : repo.license?.spdx_id || '未取得'}`));
    renderMonthly(m.monthly || []); renderIssues(m.recent_issues || [], repo);
  }
  function renderMonthly(months) {
    const container = $('monthly-chart');
    if (!months.length) { container.append(node('div', 'empty-state', '所选窗口没有采集记录。')); return; }
    // Very long historical samples are binned into <= 12 consecutive month groups.
    const groupSize = Math.ceil(months.length / 12), grouped = [];
    for (let i = 0; i < months.length; i += groupSize) { const chunk = months.slice(i, i + groupSize); grouped.push({ label: chunk.length === 1 ? chunk[0].month : `${chunk[0].month} ~ ${chunk.at(-1).month}`, short: chunk.length === 1 ? chunk[0].month.slice(2) : chunk[0].month.slice(2) + '+', issues: chunk.reduce((n, item) => n + item.issues, 0), prs: chunk.reduce((n, item) => n + item.prs, 0) }); }
    const chart = node('div', 'month-chart'); chart.setAttribute('role', 'img'); chart.setAttribute('aria-label', grouped.map(item => `${item.label}：${item.issues} 条 Issue，${item.prs} 条 PR`).join('；'));
    const max = Math.max(1, ...grouped.map(item => item.issues + item.prs));
    grouped.forEach(item => { const col = node('div', 'month-column'), total = item.issues + item.prs, bars = node('div', 'month-bars'); bars.style.height = `${total / max * 120}px`; const issues = node('span', 'bar-issue'), prs = node('span', 'bar-pr'); issues.style.height = `${total ? item.issues / total * 100 : 0}%`; prs.style.height = `${total ? item.prs / total * 100 : 0}%`; bars.append(issues, prs); col.append(node('span', 'month-value', number(total)), bars, node('span', 'month-label', item.short)); chart.append(col); }); container.append(chart);
    const legend = node('div', 'legend'); [['legend-issue', 'Issue'], ['legend-pr', 'Pull Request']].forEach(([cls, label]) => { const item = node('span'); item.append(node('i', cls), document.createTextNode(label)); legend.append(item); }); legend.style.marginTop = '20px'; container.append(legend);
    container.append(node('p', 'chart-caption', groupSize > 1 ? `按每 ${groupSize} 个有记录月份合并展示；此图描述样本分布。` : '边界月份可能只覆盖部分日期；采样截断会影响分布。'));
  }
  function renderIssues(issues, repo) {
    const container = $('issue-list'); $('issue-count').textContent = repo.name;
    if (!issues.length) { container.append(node('div', 'empty-state', '所选创建时间范围内没有 Issue 样本。')); return; }
    issues.slice(0, 10).forEach(issue => { const row = node('div', 'issue-row'), closed = issue.state === 'closed'; row.append(node('span', `issue-status ${closed ? 'status-closed' : 'status-open'}`, closed ? '已关闭' : '未关闭')); const content = node('div'); content.append(safeLink(issue.title || `Issue #${issue.number}`, issue.url, 'issue-title'), node('div', 'issue-meta', `#${issue.number} · 创建 ${date(issue.created_at)} · ${number(issue.comments)} 条评论`)); row.append(content); const age = node('div', 'issue-age'); age.append(node('strong', '', days(issue.age_days)), document.createTextNode(' 天'), node('div', '', '创建至采集')); row.append(age); container.append(row); });
  }
  function renderCoverage(list) {
    const tbody = $('coverage-body'); tbody.replaceChildren();
    if (!list.length) { const row = node('tr'), cell = node('td', '', '暂无匹配仓库'); cell.colSpan = 5; row.append(cell); tbody.append(row); return; }
    list.forEach(repo => { const coverage = repo.coverage || {}, row = node('tr'); row.append(node('td', '', repo.name), node('td', '', number(coverage.records)), node('td', '', date(coverage.oldest_created_at)), node('td', '', date(coverage.newest_created_at))); const cell = node('td'), errors = coverage.errors || []; cell.append(node('span', `coverage-status ${errors.length ? 'coverage-error' : coverage.truncated ? '' : 'coverage-complete'}`, errors.length ? '存在采集提示' : coverage.truncated ? '样本截断' : '已到分页末尾')); if (errors.length) cell.append(node('div', 'coverage-warning', errors.map(error => typeof error === 'string' ? error : JSON.stringify(error)).join('；'))); if (state.window !== 'all' && coverage.truncated && Date.parse(coverage.oldest_created_at) > Date.parse(data.collected_at) - Number(state.window) * 86400000) cell.append(node('div', 'coverage-warning', `${state.window} 天窗口未完整覆盖`)); row.append(cell); tbody.append(row); });
  }
  function render() { const list = filtered(); if (!list.some(repo => repo.name === state.selected)) state.selected = list[0]?.name || null; renderSummary(list); renderComparison(list); renderDetail(list.find(repo => repo.name === state.selected)); renderCoverage(list); }
  const timeLabel = value => String(value || '').replace('T', ' ').replace(/\.\d+Z$/, 'Z').replace('Z', '');
  $('snapshot-date').textContent = `采集区间（UTC） ${timeLabel(data.collected_at)}${data.collection_finished_at ? ' 至 ' + timeLabel(data.collection_finished_at) : ''}`;
  $('snapshot-total').textContent = `${number(data.totals?.repositories ?? repositories.length)} 个仓库 · ${number(data.totals?.records)} 条去重后记录`;
  (data.limitations || []).forEach(text => $('limitations').append(node('li', '', text)));
  $('repo-search').addEventListener('input', event => { state.query = event.target.value; render(); });
  $('window-select').addEventListener('change', event => { state.window = event.target.value; render(); });
  $('sort-select').addEventListener('change', event => { state.sort = event.target.value; render(); });
  $('reset-button').addEventListener('click', () => { Object.assign(state, { window: '90', query: '', sort: 'issues', selected: null }); $('repo-search').value = ''; $('window-select').value = '90'; $('sort-select').value = 'issues'; render(); });
  $('export-button').addEventListener('click', () => { const payload = { schema_version: data.schema_version, collected_at: data.collected_at, collection_finished_at: data.collection_finished_at, source: data.source, sampling: data.sampling, filter: { creation_window: state.window, search: state.query, sort: state.sort }, repositories: filtered().map(repo => ({ name: repo.name, url: repo.url, has_issues: repo.has_issues, coverage: repo.coverage, metrics: metrics(repo) })), limitations: data.limitations }; const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }); const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = `openrepo-lens-${state.window}-${date(data.collected_at)}.json`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000); $('result-announcement').textContent = '当前筛选数据已导出为 JSON 文件。'; });
  document.querySelectorAll('.nav-link').forEach(link => link.addEventListener('click', () => { document.querySelectorAll('.nav-link').forEach(item => item.classList.remove('active')); link.classList.add('active'); }));
  render();
})();
