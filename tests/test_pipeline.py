import hashlib
import json
from pathlib import Path
import unittest
import sys
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pipeline import calculate_metrics, load_response, parse_time, prepare_records


SNAPSHOT = parse_time("2026-10-28T12:00:00Z")


def record(number, created="2026-10-01T12:00:00Z", state="open", closed=None, pr=False):
    result = {"id": number, "number": number, "title": f"Issue {number}", "created_at": created,
              "state": state, "closed_at": closed, "comments": 0, "html_url": "https://github.com/example/repo/issues/1"}
    if pr:
        result["pull_request"] = {}
    return result


class MetricsTests(unittest.TestCase):
    def test_pr_exclusion_from_issue_denominator(self):
        values = [record(1, state="closed", closed="2026-10-03T12:00:00Z"), record(2), record(3, pr=True)]
        actual = calculate_metrics(values, SNAPSHOT)
        self.assertEqual(actual["issues"], 2)
        self.assertEqual(actual["prs"], 1)
        self.assertEqual(actual["closed_ratio"], 0.5)
        self.assertEqual(actual["median_closed_days"], 2.0)

    def test_creation_window_includes_boundary_only(self):
        values = [record(1, "2026-09-28T12:00:00Z"), record(2, "2026-09-28T11:59:59Z")]
        self.assertEqual(calculate_metrics(values, SNAPSHOT, 30)["issues"], 1)
        self.assertEqual(calculate_metrics(values, SNAPSHOT, 90)["issues"], 2)

    def test_dedup_and_future_creation(self):
        values = [record(1), record(1), record(2, "2026-10-28T12:00:01Z"), record(3, "bad")]
        actual, excluded = prepare_records(values, SNAPSHOT)
        self.assertEqual([v["id"] for v in actual], [1])
        self.assertEqual(excluded, {"duplicate_id": 1, "created_after_cutoff": 1, "invalid_created_at": 1})

    def test_invalid_closure_is_excluded_from_duration_not_state(self):
        values = [record(1, state="closed", closed="2026-09-30T12:00:00Z"), record(2, state="closed"),
                  record(3, state="closed", closed="2026-11-01T12:00:00Z")]
        actual = calculate_metrics(values, SNAPSHOT)
        self.assertEqual(actual["closed_issues"], 3)
        self.assertEqual(actual["closed_ratio"], 1)
        self.assertIsNone(actual["median_closed_days"])
        self.assertEqual(actual["closed_duration_n"], 0)
        self.assertEqual(sum(actual["excluded_durations"].values()), 3)

    def test_empty_and_pr_only_nulls(self):
        for values in ([], [record(1, pr=True)]):
            actual = calculate_metrics(values, SNAPSHOT)
            for key in ("closed_ratio", "median_closed_days", "median_open_age_days", "oldest_open_days"):
                self.assertIsNone(actual[key])

    def test_current_open_age_and_conditional_median(self):
        values = [record(1), record(2, state="closed", closed="2026-10-05T12:00:00Z"),
                  record(3, state="closed", closed="2026-10-03T12:00:00Z")]
        actual = calculate_metrics(values, SNAPSHOT)
        self.assertEqual(actual["median_open_age_days"], 27)
        self.assertEqual(actual["oldest_open_days"], 27)
        self.assertEqual(actual["median_closed_days"], 3)
        self.assertEqual(actual["closed_duration_n"], 2)

    def test_timezone_normalization_and_naive_rejected(self):
        self.assertEqual(parse_time("2026-10-28T20:00:00+08:00"), SNAPSHOT)
        self.assertIsNone(parse_time("2026-10-28T12:00:00"))

    def test_raw_integrity_failure_returns_no_data(self):
        root = Path(__file__).resolve().parent / ("scratch_" + uuid.uuid4().hex)
        root.mkdir()
        try:
            (root / "sample.json").write_text("[]", encoding="utf-8")
            entry = {"kind": "issues_page_1", "status": 200, "path": "sample.json", "sha256": "wrong"}
            errors = []
            self.assertIsNone(load_response(root, entry, errors))
            self.assertIn("SHA256", errors[0])
            entry["sha256"] = hashlib.sha256(b"[]").hexdigest()
            self.assertEqual(load_response(root, entry, []), [])
        finally:
            (root / "sample.json").unlink(missing_ok=True)
            root.rmdir()


if __name__ == "__main__":
    unittest.main()
