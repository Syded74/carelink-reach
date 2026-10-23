"""Loads community-level datasets and enforces the privacy boundary.

The engines only ever receive the fields whitelisted here: community identifiers, place names,
weekly counts and dates. Anything else (a person, a phone number, a note) makes loading fail, so
identifying data cannot reach the forecaster or optimiser by accident.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path

DATASET_KEYS = {"dataset_id", "label", "synthetic", "exported_at", "source", "period", "as_of",
                "communities", "history", "current", "provenance_ref", "notes", "confirmed_assignments",
                "includes_test_records"}  # true only for a plan request marked as a regression test
CONFIRMED_KEYS = {"worker", "day", "community", "min_followups", "source"}  # staff and place ids only
COMMUNITY_KEYS = {"id", "name", "barrier_level", "responsible_worker"}  # worker = staff id, not a patient
HISTORY_KEYS = {"community_id", "period_start", "reported", "requests_created", "followups_due",
                "missed_appointments", "referrals_open", "visits_completed", "transport_barriers", "followups_resolved"}
# pending_followups is the documented routine workload in encounters; the other counts say where it comes from.
CURRENT_KEYS = {"community_id", "as_of", "pending_followups", "urgent_items_excluded", "last_visit",
                "open_requests", "open_maternal_followups", "open_child_followups", "unique_people", "unique_households",
                "encounters_request", "encounters_anc", "encounters_pnc", "encounters_cwc",
                # Coverage indicators (counts only; -1 = no documented outreach yet).
                "days_since_outreach", "unserved_planned", "visits_completed_4w"}
COUNT_FIELDS = ["requests_created", "followups_due", "missed_appointments", "referrals_open",
                "visits_completed", "transport_barriers", "followups_resolved"]
# Routine outreach workload: operational work items, never a clinical risk measure.
WORKLOAD_FIELDS = ["requests_created", "followups_due", "missed_appointments", "referrals_open"]
BARRIER_LEVELS = {"high", "low", "unknown"}


class DatasetError(ValueError):
    pass


@dataclass
class Dataset:
    dataset_id: str
    label: str
    synthetic: bool
    exported_at: str
    source: str
    as_of: str
    communities: list[dict]
    history: list[dict]
    current: dict[str, dict]
    notes: list[str] = field(default_factory=list)
    confirmed: list[dict] = field(default_factory=list)
    sha256: str = ""
    duplicates_removed: int = 0

    def community(self, community_id: str) -> dict:
        return next(c for c in self.communities if c["id"] == community_id)


def _check_keys(record: dict, allowed: set[str], where: str) -> None:
    extra = set(record) - allowed
    if extra:
        raise DatasetError(f"{where}: fields {sorted(extra)} are not allowed in engine inputs")


def parse(raw: dict) -> Dataset:
    _check_keys(raw, DATASET_KEYS, "dataset")
    ids = set()
    for c in raw["communities"]:
        _check_keys(c, COMMUNITY_KEYS, "community")
        if c.get("barrier_level", "unknown") not in BARRIER_LEVELS:
            raise DatasetError(f"community {c['id']}: unknown barrier_level {c['barrier_level']!r}")
        ids.add(c["id"])
    # One row per community and period. A repeated export or sync of the same period keeps the
    # last row instead of adding to it, so re-syncs cannot inflate demand.
    rows: dict[tuple[str, str], dict] = {}
    duplicates = 0
    for row in raw.get("history", []):
        _check_keys(row, HISTORY_KEYS, "history row")
        if row["community_id"] not in ids:
            raise DatasetError(f"history row for unknown community {row['community_id']}")
        for name in COUNT_FIELDS:
            value = row.get(name, 0)
            if not isinstance(value, int) or value < 0:
                raise DatasetError(f"{row['community_id']} {row['period_start']}: {name} must be a non-negative integer")
        key = (row["community_id"], row["period_start"])
        duplicates += key in rows
        rows[key] = {**{n: 0 for n in COUNT_FIELDS}, "reported": True, **row}
    current = {}
    for row in raw.get("current", []):
        _check_keys(row, CURRENT_KEYS, "current row")
        if row["community_id"] not in ids:
            raise DatasetError(f"current row for unknown community {row['community_id']}")
        current[row["community_id"]] = row
    confirmed = []
    for row in raw.get("confirmed_assignments", []):
        _check_keys(row, CONFIRMED_KEYS, "confirmed assignment")
        confirmed.append(row)
    canonical = json.dumps(raw, sort_keys=True).encode()
    return Dataset(
        dataset_id=raw["dataset_id"], label=raw.get("label", raw["dataset_id"]), synthetic=bool(raw.get("synthetic")),
        exported_at=raw.get("exported_at", ""), source=raw.get("source", ""), as_of=raw["as_of"],
        communities=[{"barrier_level": "unknown", **c} for c in raw["communities"]],
        history=sorted(rows.values(), key=lambda r: (r["community_id"], r["period_start"])),
        current=current, notes=list(raw.get("notes", [])), confirmed=confirmed, sha256=hashlib.sha256(canonical).hexdigest(),
        duplicates_removed=duplicates,
    )


def load(path: str | Path) -> Dataset:
    return parse(json.loads(Path(path).read_text()))


def workload(row: dict) -> int:
    return sum(row.get(name, 0) for name in WORKLOAD_FIELDS)
