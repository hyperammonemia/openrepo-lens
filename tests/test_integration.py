"""Independent checks against the saved API evidence; no network requests."""
from collections import Counter
from datetime import datetime, timedelta
import hashlib
import json
from pathlib import Path
import re
import statistics
import sys
import unittest
from unittest.mock import patch
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pipeline
import build

ROOT = Path(__file__).resolve().parents[1]


def timestamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


class SnapshotIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = json.loads((ROOT / "data/manifest.json").read_text(encoding="utf-8"))
        cls.analysis = json.loads((ROOT / "output/analysis.json").read_text(encoding="utf-8"))
        cls.cutoff = timestamp(cls.manifest["snapshot_start"])

    def test_raw_evidence_integrity_and_request_interval(self):
        paths = []
        for request in self.manifest["requests"]:
            self.assertTrue(request["url"].startswith("https://api.github.com/repos/"))
            self.assertLessEqual(timestamp(request["requested_at"]), timestamp(request["received_at"]))
            self.assertLessEqual(self.cutoff, timestamp(request["requested_at"]))
            self.assertLessEqual(timestamp(request["received_at"]), timestamp(self.manifest["collection_finished_at"]))
            if request.get("path"):
                path = (ROOT / request["path"]).resolve()
                self.assertTrue(path.is_relative_to(ROOT / "data/raw"))
                paths.append(str(path))
                raw = path.read_bytes()
                self.assertEqual(len(raw), request["bytes"])
                self.assertEqual(hashlib.sha256(raw).hexdigest(), request["sha256"])
        self.assertEqual(len(paths), len(set(paths)))

    def test_counts_reconcile_with_distinct_raw_records(self):
        totals = Counter()
        for repo in self.analysis["repositories"]:
            unique = {}
            for request in self.manifest["requests"]:
                if request["repo"] == repo["name"] and request["kind"].startswith("issues_page_") and request["status"] == 200:
                    for record in json.loads((ROOT / request["path"]).read_bytes()):
                        unique.setdefault(record["id"], record)
            accepted = [r for r in unique.values() if timestamp(r["created_at"]) <= self.cutoff]
            self.assertLessEqual(len(accepted), self.analysis["sampling"]["max_records_per_repo"])
            expected_issues = sum("pull_request" not in r for r in accepted)
            self.assertEqual(repo["coverage"]["records"], len(accepted))
            self.assertEqual(repo["coverage"]["issues"], expected_issues)
            self.assertEqual(repo["coverage"]["prs"], len(accepted) - expected_issues)
            for window, metrics in repo["windows"].items():
                selected = accepted if window == "all" else [r for r in accepted if timestamp(r["created_at"]) >= self.cutoff - timedelta(days=int(window))]
                self.assertEqual(metrics["issues"] + metrics["prs"], len(selected))
                actual_issues = [r for r in selected if "pull_request" not in r]
                self.assertEqual(metrics["issues"], len(actual_issues))
                closed = [r for r in actual_issues if r["state"] == "closed"]
                self.assertEqual(metrics["closed_issues"], len(closed))
                ratio = len(closed) / len(actual_issues) if actual_issues else None
                if ratio is None:
                    self.assertIsNone(metrics["closed_ratio"])
                else:
                    self.assertAlmostEqual(metrics["closed_ratio"], ratio, places=6)
                durations = [(timestamp(r["closed_at"]) - timestamp(r["created_at"])).total_seconds() / 86400 for r in closed if r.get("closed_at") and timestamp(r["created_at"]) <= timestamp(r["closed_at"]) <= self.cutoff]
                self.assertEqual(metrics["closed_duration_n"], len(durations))
                if durations:
                    self.assertAlmostEqual(metrics["median_closed_days"], statistics.median(durations), places=4)
                else:
                    self.assertIsNone(metrics["median_closed_days"])
                self.assertEqual(sum(m["issues"] for m in metrics["monthly"]), metrics["issues"])
                self.assertEqual(sum(m["prs"] for m in metrics["monthly"]), metrics["prs"])
            totals.update({key: repo["coverage"][key] for key in ("records", "issues", "prs")})
        for key, value in totals.items():
            self.assertEqual(self.analysis["totals"][key], value)
        self.assertEqual(self.analysis["totals"]["repositories"], len(self.analysis["repositories"]))

    def test_no_false_complete_window_or_atomic_snapshot_claim(self):
        self.assertEqual(self.analysis["collected_at"], self.manifest["snapshot_start"])
        self.assertEqual(self.analysis["collection_finished_at"], self.manifest["collection_finished_at"])
        self.assertTrue(self.analysis["sampling"]["state_reference"])
        self.assertGreaterEqual(len(self.analysis["limitations"]), 5)
        for repo in self.analysis["repositories"]:
            page2 = next(r for r in self.manifest["requests"] if r["repo"] == repo["name"] and r["kind"] == "issues_page_2")
            if 'rel="next"' in page2["headers"].get("link", ""):
                self.assertTrue(repo["coverage"]["truncated"])

    def test_offline_reanalysis_reproduces_exact_json(self):
        with patch.object(pipeline, "write_json") as writer, patch.object(pipeline, "urlopen", side_effect=AssertionError("Offline analysis attempted network access")):
            actual = pipeline.analyze(ROOT)
        self.assertEqual(actual, self.analysis)
        writer.assert_called_once_with(ROOT / "output/analysis.json", self.analysis)

    def test_standalone_dashboard_embeds_exact_analysis(self):
        html = (ROOT / "output/index.html").read_text(encoding="utf-8")
        payload = re.search(r'<script id="analysis-data" type="application/json">(.*?)</script>', html, re.S)
        self.assertIsNotNone(payload)
        self.assertEqual(json.loads(payload.group(1)), self.analysis)
        self.assertIsNone(re.search(r'<script\b[^>]*\bsrc=', html, re.I))
        self.assertIsNone(re.search(r'<link\b[^>]*\bhref=', html, re.I))
        self.assertIn('<html lang="zh-CN">', html)

    def test_build_escapes_script_terminators_and_preserves_marker_text(self):
        scratch = ROOT / "tests" / ("buildcheck_" + uuid.uuid4().hex)
        scratch.mkdir()
        try:
            value = json.loads(json.dumps(self.analysis))
            malicious = '</script><script>window.injected=true</script> /*__SCRIPT__*/ /*__STYLE__*/'
            value["repositories"][0]["description"] = malicious
            source = scratch / "input.json"
            source.write_text(json.dumps(value), encoding="utf-8")
            destination = scratch / "index.html"
            build.build(source, destination)
            html = destination.read_text(encoding="utf-8")
            payload = re.search(r'<script id="analysis-data" type="application/json">(.*?)</script>', html, re.S)
            self.assertIsNotNone(payload)
            self.assertNotIn('<script>window.injected', html)
            self.assertEqual(json.loads(payload.group(1)), value)
            self.assertEqual(len(re.findall(r"<script\b", html, re.I)), 2)
        finally:
            for path in scratch.iterdir():
                path.unlink()
            scratch.rmdir()


if __name__ == "__main__":
    unittest.main()
