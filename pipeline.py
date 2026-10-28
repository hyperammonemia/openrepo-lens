"""Collect a bounded GitHub sample and rebuild descriptive metrics offline.

Only Python's standard library is required. No credentials are read or saved.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import statistics
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
DEFAULT_REPOS = ["pallets/flask", "django/django", "fastapi/fastapi", "encode/starlette", "sanic-org/sanic"]
UTC = timezone.utc


def iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_time(value):
    if not isinstance(value, str):
        return None
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if result.tzinfo is None:
            return None
        return result.astimezone(UTC)
    except ValueError:
        return None


def write_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(path)


def median(values):
    return round(statistics.median(values), 4) if values else None


def prepare_records(records, snapshot):
    """Deduplicate by immutable ID and exclude unusable or post-cutoff creation times."""
    accepted = []
    seen = set()
    excluded = defaultdict(int)
    for item in records:
        identifier = item.get("id")
        if identifier is None:
            excluded["missing_id"] += 1
            continue
        if identifier in seen:
            excluded["duplicate_id"] += 1
            continue
        seen.add(identifier)
        created = parse_time(item.get("created_at"))
        if created is None:
            excluded["invalid_created_at"] += 1
            continue
        if created > snapshot:
            excluded["created_after_cutoff"] += 1
            continue
        accepted.append(item)
    accepted.sort(key=lambda item: (item["created_at"], item["id"]), reverse=True)
    return accepted, dict(excluded)


def calculate_metrics(records, snapshot, days=None):
    cutoff = snapshot - timedelta(days=days) if days is not None else None
    selected = [r for r in records if cutoff is None or parse_time(r["created_at"]) >= cutoff]
    issues = [r for r in selected if "pull_request" not in r]
    prs = [r for r in selected if "pull_request" in r]
    closed = [r for r in issues if r.get("state") == "closed"]
    opened = [r for r in issues if r.get("state") == "open"]
    durations = []
    excluded = defaultdict(int)
    for r in closed:
        created = parse_time(r["created_at"])
        ended = parse_time(r.get("closed_at"))
        if ended is None:
            excluded["closed_without_valid_closed_at"] += 1
        elif ended < created:
            excluded["negative_closed_duration"] += 1
        elif ended > snapshot:
            excluded["closed_after_cutoff"] += 1
        else:
            durations.append((ended - created).total_seconds() / 86400)
    unknown = len(issues) - len(closed) - len(opened)
    if unknown:
        excluded["unknown_state"] = unknown
    open_ages = [(snapshot - parse_time(r["created_at"])).total_seconds() / 86400 for r in opened]
    monthly = defaultdict(lambda: {"issues": 0, "prs": 0})
    for r in selected:
        monthly[r["created_at"][:7]]["prs" if "pull_request" in r else "issues"] += 1
    recent = []
    for r in issues[:10]:
        recent.append({
            "number": r.get("number"), "title": r.get("title", ""),
            "url": r.get("html_url"), "state": r.get("state"),
            "created_at": r["created_at"], "closed_at": r.get("closed_at"),
            "comments": r.get("comments", 0),
            "age_days": round((snapshot - parse_time(r["created_at"])).total_seconds() / 86400, 4),
        })
    return {
        "issues": len(issues), "prs": len(prs), "closed_issues": len(closed),
        "open_issues": len(opened),
        "closed_ratio": round(len(closed) / len(issues), 6) if issues else None,
        "median_closed_days": median(durations), "closed_duration_n": len(durations),
        "median_open_age_days": median(open_ages),
        "oldest_open_days": round(max(open_ages), 4) if open_ages else None,
        "excluded_durations": dict(excluded),
        "monthly": [{"month": month, **counts} for month, counts in sorted(monthly.items())],
        "recent_issues": recent,
    }


def load_response(root, entry, errors):
    if entry.get("status") != 200 or not entry.get("path"):
        errors.append(f"{entry['kind']}: {entry.get('error', '请求未成功')}")
        return None
    path = root / entry["path"]
    try:
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != entry["sha256"]:
            raise ValueError("原始响应 SHA256 校验失败")
        return json.loads(raw)
    except (OSError, ValueError) as error:
        errors.append(f"{entry['kind']}: {error}")
        return None


def analyze(root=ROOT):
    manifest = json.loads((root / "data/manifest.json").read_text(encoding="utf-8"))
    snapshot = parse_time(manifest["snapshot_start"])
    if snapshot is None:
        raise ValueError("Invalid snapshot_start in manifest")
    repositories = []
    for name in manifest["repositories"]:
        entries = [e for e in manifest["requests"] if e["repo"] == name]
        errors = []
        loaded = {e["kind"]: load_response(root, e, errors) for e in entries}
        metadata = loaded.get("metadata") or {}
        raw_issues = []
        for kind in ("issues_page_1", "issues_page_2"):
            value = loaded.get(kind)
            if isinstance(value, list):
                raw_issues.extend(value)
            elif value is not None:
                errors.append(f"{kind}: 预期数组，未参与分析")
        records, excluded = prepare_records(raw_issues, snapshot)
        if excluded:
            errors.append("记录过滤: " + json.dumps(excluded, ensure_ascii=False))
        releases = loaded.get("release")
        release = None
        if isinstance(releases, list) and releases:
            value = releases[0]
            release = {"tag": value.get("tag_name"), "published_at": value.get("published_at"), "url": value.get("html_url"), "prerelease": value.get("prerelease", False)}
        page2 = next((e for e in entries if e["kind"] == "issues_page_2"), {})
        truncated = 'rel="next"' in page2.get("headers", {}).get("link", "") or len(raw_issues) >= 200
        windows = {key: calculate_metrics(records, snapshot, days) for key, days in (("30", 30), ("90", 90), ("all", None))}
        repositories.append({
            "name": name, "url": metadata.get("html_url", f"https://github.com/{name}"),
            "description": metadata.get("description"), "language": metadata.get("language"),
            "stars": metadata.get("stargazers_count"), "forks": metadata.get("forks_count"),
            "archived": metadata.get("archived"), "license": (metadata.get("license") or {}).get("spdx_id"),
            "pushed_at": metadata.get("pushed_at"), "has_issues": metadata.get("has_issues"),
            "latest_release": release,
            "coverage": {
                "records": len(records), "issues": windows["all"]["issues"], "prs": windows["all"]["prs"],
                "oldest_created_at": records[-1]["created_at"] if records else None,
                "newest_created_at": records[0]["created_at"] if records else None,
                "truncated": truncated, "errors": errors, "excluded_records": excluded,
                "requested_pages": 2,
                "successful_pages": sum(loaded.get(k) is not None for k in ("issues_page_1", "issues_page_2")),
            }, "windows": windows,
        })
    result = {
        "schema_version": 1, "collected_at": manifest["snapshot_start"],
        "collection_finished_at": manifest["collection_finished_at"], "source": "GitHub REST API",
        "sampling": {
            "description": "每个仓库按创建时间倒序读取最多 200 条 Issue 与 PR 混合记录，再按创建时间筛选 30 天、90 天或全部已采集样本。",
            "max_records_per_repo": 200,
            "selection": "人工选取五个 Python Web 框架作为便利样本，不能代表全部开源项目。",
            "state_reference": "各响应读取时的当前状态；时间筛选只针对创建时间，不重建历史状态。",
        },
        "repositories": repositories,
        "totals": {"repositories": len(repositories), **{key: sum(r["coverage"][key] for r in repositories) for key in ("records", "issues", "prs")}},
        "limitations": [
            "这是按最新创建记录截取的描述性样本，不能当作仓库全部历史、全部积压或随机样本。不同仓库覆盖的日期不同。",
            "30 天和 90 天筛选仅作用于已采集记录；当样本最早日期晚于窗口起点时，该窗口覆盖不完整。",
            "关闭比例是样本 Issue 的当前关闭状态比例。关闭可能代表重复、拒绝或其他处理，并不等于问题已修复。",
            "关闭耗时中位数仅统计有有效关闭时间的已关闭 Issue，排除尚未关闭记录，不能代表整体解决速度。",
            "API 顺序读取期间数据可能变化；创建时间晚于采集起点的记录被排除，当前状态不代表采集起点的历史状态。",
            "部分项目在其他平台管理问题，或停用 GitHub Issues。零条 Issue 不能解释为零问题或维护更好。",
            "发布信息取 GitHub releases 列表的首条；无记录不代表没有软件版本发布。仓库推送时间也不等同于代码质量。",
            "这些观察不能直接用于安全、质量或维护风险排名；项目选择及样本上限会影响结果。",
        ],
    }
    write_json(root / "output/analysis.json", result)
    return result


def collect(root=ROOT, repos=None):
    repos = repos or DEFAULT_REPOS
    start = datetime.now(UTC)
    run_id = start.strftime("%Y%m%dT%H%M%S%fZ")
    raw_dir = root / "data/raw" / run_id
    raw_dir.mkdir(parents=True, exist_ok=False)
    manifest = {"schema_version": 1, "snapshot_start": iso(start), "repositories": repos, "requests": []}
    rate_limited = False
    for name in repos:
        base = f"https://api.github.com/repos/{name}"
        endpoints = [("metadata", base), ("issues_page_1", base + "/issues?state=all&sort=created&direction=desc&per_page=100&page=1"),
                     ("issues_page_2", base + "/issues?state=all&sort=created&direction=desc&per_page=100&page=2"),
                     ("release", base + "/releases?per_page=1")]
        for kind, url in endpoints:
            entry = {"repo": name, "kind": kind, "url": url, "requested_at": iso(datetime.now(UTC)), "headers": {}}
            raw = None
            if rate_limited:
                entry.update(status=None, error="已达到 API 限额，跳过后续请求")
            else:
                req = Request(url, headers={"User-Agent": "OpenRepo-Lens-Portfolio/1.0", "Accept": "application/vnd.github+json"})
                try:
                    with urlopen(req, timeout=30) as response:
                        raw = response.read()
                        entry["status"] = response.status
                        headers = response.headers
                except HTTPError as error:
                    raw = error.read()
                    headers = error.headers
                    entry.update(status=error.code, error=f"HTTP {error.code}")
                    if error.code == 429 or (error.code == 403 and headers.get("X-RateLimit-Remaining") == "0"):
                        rate_limited = True
                except (URLError, TimeoutError, OSError) as error:
                    headers = {}
                    entry.update(status=None, error=str(error))
                for header in ("Date", "X-RateLimit-Remaining", "X-RateLimit-Reset", "X-GitHub-Request-Id", "Link", "ETag"):
                    if headers.get(header) is not None:
                        entry["headers"][header.lower()] = headers.get(header)
                if entry["headers"].get("x-ratelimit-remaining") == "0":
                    rate_limited = True
            entry["received_at"] = iso(datetime.now(UTC))
            if raw is not None:
                path = raw_dir / (name.replace("/", "__") + "__" + kind + ".json")
                path.write_bytes(raw)
                entry["path"] = path.relative_to(root).as_posix()
                entry["sha256"] = hashlib.sha256(raw).hexdigest()
                entry["bytes"] = len(raw)
            manifest["requests"].append(entry)
            print(f"{name} {kind}: {entry.get('status')} ({entry['headers'].get('x-ratelimit-remaining', '?')} requests left)", flush=True)
    manifest["collection_finished_at"] = iso(datetime.now(UTC))
    write_json(raw_dir / "manifest.json", manifest)
    write_json(root / "data/manifest.json", manifest)
    return analyze(root)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["collect", "analyze"])
    args = parser.parse_args()
    result = collect() if args.command == "collect" else analyze()
    print(json.dumps(result["totals"], ensure_ascii=False))
    errors = sum(len(r["coverage"]["errors"]) for r in result["repositories"])
    if errors:
        print(f"{errors} coverage warnings; inspect output/analysis.json", file=sys.stderr)
    return 0 if result["totals"]["records"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
