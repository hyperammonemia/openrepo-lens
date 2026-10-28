"""Build the offline, dependency-free HTML dashboard from a real analysis snapshot."""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def build(analysis_path: Path, output_path: Path) -> Path:
    data = json.loads(analysis_path.read_text(encoding="utf-8"))
    if data.get("schema_version") != 1 or not isinstance(data.get("repositories"), list):
        raise ValueError("Unsupported analysis schema: expected schema_version 1 and repositories list")
    template = (ROOT / "web" / "template.html").read_text(encoding="utf-8")
    replacements = {
        "/*__STYLE__*/": (ROOT / "web" / "style.css").read_text(encoding="utf-8"),
        "/*__DATA__*/": json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029"),
        "/*__SCRIPT__*/": (ROOT / "web" / "app.js").read_text(encoding="utf-8"),
    }
    for marker in replacements:
        if template.count(marker) != 1:
            raise ValueError(f"Template must contain exactly one {marker} placeholder")
    pattern = re.compile("|".join(re.escape(marker) for marker in replacements))
    template = pattern.sub(lambda match: replacements[match.group(0)], template)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_suffix(".html.tmp")
    temporary.write_text(template, encoding="utf-8", newline="\n")
    temporary.replace(output_path)
    print(f"Built {output_path} ({output_path.stat().st_size:,} bytes, {len(data['repositories'])} repositories)")
    return output_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--analysis", type=Path, default=ROOT / "output" / "analysis.json")
    parser.add_argument("--output", type=Path, default=ROOT / "output" / "index.html")
    args = parser.parse_args()
    build(args.analysis, args.output)
