"""Build a Chinese report describing the saved GitHub snapshot."""
import html
import json
from pathlib import Path
from datetime import datetime, timedelta

ROOT = Path(__file__).resolve().parent


def main():
    data = json.loads((ROOT / 'output/analysis.json').read_text(encoding='utf-8'))
    manifest = json.loads((ROOT / 'data/manifest.json').read_text(encoding='utf-8'))
    total = data['totals']
    requests = len(manifest['requests'])
    successful = sum(x.get('status') == 200 for x in manifest['requests'])
    snapshot = datetime.fromisoformat(data['collected_at'].replace('Z', '+00:00'))
    cutoff = snapshot - timedelta(days=90)
    rows = []
    incomplete = []
    for repo in data['repositories']:
        c = repo['coverage']
        m = repo['windows']['90']
        oldest = c['oldest_created_at']
        full = (not c['truncated'] or (oldest and datetime.fromisoformat(oldest.replace('Z', '+00:00')) <= cutoff)) and c['successful_pages'] == 2
        if not full:
            incomplete.append(repo['name'])
        pct = '无 Issue 样本' if m['closed_ratio'] is None else f"{m['closed_ratio']:.1%}"
        days = '无有效已关闭样本' if m['median_closed_days'] is None else f"{m['median_closed_days']:.4f} 天 (n={m['closed_duration_n']})"
        cells = [repo['name'], str(c['issues']), str(c['prs']), (oldest or '')[:10], str(m['issues']), pct, days, '达到窗口起点' if full else '窗口覆盖不完整']
        rows.append('<tr>' + ''.join('<td>' + html.escape(x) + '</td>' for x in cells) + '</tr>')
    limits = ''.join('<li>' + html.escape(x) + '</li>' for x in data['limitations'])
    report = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenRepo Lens · 数据分析说明</title><style>
body{margin:0;background:#f5f5f1;color:#182c34;font:16px/1.8 system-ui,"Microsoft YaHei",sans-serif}main{max-width:1100px;margin:auto;padding:48px 28px}h1{font-size:34px;line-height:1.3}h2{margin-top:36px;font-size:23px}a{color:#146656}small{color:#52636b}.tag{color:#146656;letter-spacing:2px}.stats{display:flex;gap:28px;flex-wrap:wrap;border-block:1px solid #cbd8d2;padding:20px 0}.stats strong{font-size:32px;display:block}.table{overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;vertical-align:top;padding:12px;border-bottom:1px solid #ccd8d3}th{background:#e8eeea;white-space:nowrap}code{background:#e6ece8;padding:2px 5px}li{margin-bottom:10px}@media(max-width:600px){main{padding:24px 18px}h1{font-size:26px}}
</style><main><p class="tag">OPENREPO LENS / SNAPSHOT REPORT</p><h1>开源项目维护状态：样本能说明什么</h1>
<p>这是一次公开数据分析与工具实现。五个框架来自方便采集的样本，分析对象是各仓库最新记录的截取，结果不代表所有开源项目。</p>
<p><a href="index.html">打开交互工作台</a></p>
'''
    report += f'<p><small>采集区间：{html.escape(data["collected_at"])} 至 {html.escape(data["collection_finished_at"])}，UTC。各响应时间单独记录在清单中。</small></p>'
    report += f'<div class="stats"><div><strong>{total["repositories"]}</strong>公开仓库</div><div><strong>{total["records"]:,}</strong>有效样本记录</div><div><strong>{total["issues"]}</strong>Issue</div><div><strong>{total["prs"]}</strong>PR</div><div><strong>{successful}/{requests}</strong>请求成功</div></div>'
    report += '<h2>90 天创建窗口的比较</h2><p>前两列计数对应全部采集样本；90 天指标只基于样本中在该窗口创建的 Issue。关闭状态取各响应读取时刻。PR 不进入 Issue 关闭比例。</p><div class="table"><table><thead><tr>'
    report += ''.join('<th>' + t + '</th>' for t in ['仓库', '样本 Issue', '样本 PR', '最早创建日', '90 天 Issue', '样本关闭比例', '已关闭耗时中位数', '90 天覆盖'])
    report += '</tr></thead><tbody>' + ''.join(rows) + '</tbody></table></div>'
    report += '<h2>本次观察</h2><p>同样设置 200 条上限，并不意味着获得相同长度的时间记录。'
    report += '、'.join(html.escape(x) for x in incomplete) + ' 的样本未覆盖完整 90 天，因此不能把样本内记录数解释成整个窗口的新增总量。</p>'
    django = next((r for r in data['repositories'] if r['name'] == 'django/django'), None)
    if django and django['coverage']['issues'] == 0:
        report += '<p>Django 样本里只有 PR，不能计算 Issue 关闭比例。工作台将其显示为缺少样本；零 Issue 也不能推导为零问题。</p>'
    report += '<p>关闭比例与已关闭耗时描述的是采集到的记录。没有纳入未关闭记录的最终耗时，也没有核验关闭原因，因此不据此评选“维护最好”的框架。</p>'
    report += '<h2>实现与证据</h2><p>Python 标准库负责采集、去重和指标计算，HTML/CSS/JavaScript 负责离线展示。每个原始响应保留 SHA256、请求 URL 和读取时间。离线重建可以与现有分析文件对照，页面无需安装依赖。</p><p>自动验证结果见 <a href="validation.json">validation.json</a>；原始数据清单见 <a href="../data/manifest.json">manifest.json</a>。截图用于记录桌面与移动端展示效果。</p>'
    report += '<h2>方法边界</h2><ul>' + limits + '</ul><h2>接口依据</h2><p><a href="https://docs.github.com/en/rest/issues/issues">GitHub Issues 接口</a>定义 Issue 与 PR 的区分字段；<a href="https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api">分页说明</a>解释如何识别下一页；<a href="https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api">限流说明</a>列出匿名请求的配额。</p></main></html>'
    (ROOT / 'output/report.html').write_text(report, encoding='utf-8')
    print('Wrote output/report.html')


if __name__ == '__main__':
    main()
