#!/usr/bin/env python3
"""prepublish_check.py — TOC regeneration + cross-ref validation for the Living Book.
Usage: python prepublish_check.py AIinEducation_v01_Master.md
Exit code 0 = freeze-ready; 1 = validation failures (blocks the pipeline)."""

import re, sys
from collections import defaultdict

path = sys.argv[1] if len(sys.argv) > 1 else "AIinEducation_v01_Master.md"
text = open(path, encoding="utf-8").read()

# 1. Extract chapter heads: "### Q7 — Title text"
heads = dict(re.findall(r"^###\s+Q(\d+)\s+—\s+(.+?)\s*$", text, re.M))
heads = {int(k): v for k, v in heads.items()}

errors = []

# 2. Completeness: exactly Q1–Q100, no gaps, no duplicates
missing = sorted(set(range(1, 101)) - set(heads))
extra = sorted(set(heads) - set(range(1, 101)))
if missing: errors.append(f"MISSING chapter heads: {missing}")
if extra: errors.append(f"OUT-OF-RANGE heads: {extra}")

# 3. Regenerate TOC verbatim from heads, grouped by Part
parts = re.findall(r"^##\s+(Part\s+[IVX]+\s+—\s+.+?)\s*$", text, re.M)
toc = ["\n## Contents — The One Hundred Questions\n"]
for m in re.finditer(r"^##\s+(Part[^\n]+)\n(.*?)(?=^##\s+Part|\Z)", text, re.M | re.S):
    toc.append(f"**{m.group(1).strip()}**")
    qs = sorted(int(q) for q in re.findall(r"^###\s+Q(\d+)\s+—", m.group(2), re.M))
    toc.extend(f"- Q{q} — {heads[q]}" for q in qs if q in heads)
    toc.append("")
open("TOC_generated.md", "w", encoding="utf-8").write("\n".join(toc))

# 4. Validate every Qn token in Cross-references lines; build reverse index
cited_by = defaultdict(set)
current_q = None
for line in text.splitlines():
    h = re.match(r"^###\s+Q(\d+)\s+—", line)
    if h: current_q = int(h.group(1))
    if re.match(r"^\*\*Cross-references", line, re.I) and current_q:
        for ref in (int(q) for q in re.findall(r"\bQ(\d+)\b", line)):
            if ref not in heads:
                errors.append(f"Q{current_q}: dangling cross-ref -> Q{ref}")
            else:
                cited_by[ref].add(current_q)

# 5. Emit cross-reference index (reverse: who cites Qn)
with open("CrossRef_Index.md", "w", encoding="utf-8") as f:
    f.write("\n## Cross-Reference Index (cited by)\n\n")
    for q in sorted(cited_by):
        f.write(f"- **Q{q}** <- {', '.join(f'Q{c}' for c in sorted(cited_by[q]))}\n")

# 6. Report
print(f"Heads found: {len(heads)}/100 | Parts: {len(parts)} | "
      f"Cross-refs indexed: {sum(len(v) for v in cited_by.values())}")
if errors:
    print("FAIL:"); [print("  -", e) for e in errors]; sys.exit(1)
print("PASS — TOC_generated.md and CrossRef_Index.md written. Freeze-ready.")
