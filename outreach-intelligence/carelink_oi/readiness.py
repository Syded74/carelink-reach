"""Resource readiness for supply-, equipment- and fuel-aware planning (docs/SUPPLY_AWARE_OPTIMIZATION.md).

Sources, in order of precedence:
1. readiness records staff confirm in CHT (carelink_resource_status, facility-level, server-stamped author);
2. the facility configuration (planning/tolon-district.json "resources"), which for this proof of concept
   holds clearly labelled simulated values.

Only quantities that are usable count towards planning: a simulated value (labelled as such) or a confirmed
value verified within `stale_after_days`. Unknown, stale, unavailable or insufficient resources contribute
what was recorded (0 for unknown and stale) and are reported, never silently treated as available.
Nothing here is clinical: requirements per visit type are illustrative configuration pending review.
"""
from __future__ import annotations

import datetime as dt

USABLE = {"simulated", "confirmed"}
STATUSES = {"simulated", "confirmed", "unavailable", "insufficient", "unknown", "stale"}


def inventory(config: dict, records: list[dict] | None = None, day: str | None = None, include_test_records: bool = False) -> dict[str, dict]:
    """Effective planning quantity per resource id, with its status and provenance.

    Readiness records written by regression tests (record_origin "test") count only for test plans.
    """
    records = [r for r in (records or []) if include_test_records or r.get("record_origin") != "test"]
    stale_days = int(config.get("resource_policy", {}).get("stale_after_days", 7))
    day = day or dt.date.today().isoformat()
    out = {}
    for r in config.get("resources", []):
        out[r["id"]] = {"id": r["id"], "name": r["name"], "category": r["category"], "unit": r["unit"],
                        "quantity": float(r.get("quantity", 0)), "reserved": float(r.get("reserved", 0)),
                        "status": r.get("status", "unknown"), "verified_at": r.get("verified_at"), "verified_by": r.get("verified_by", ""),
                        "source": "simulated configuration" if r.get("status") == "simulated" else "configuration"}
    # The latest record per resource wins; records name an author stamped by the server.
    for rec in sorted(records or [], key=lambda d: d.get("reported_date", 0)):
        f = rec.get("fields", {})
        rid = f.get("resource_id")
        if rid not in out or f.get("status") not in STATUSES - {"simulated", "stale"}:
            continue
        out[rid].update({"quantity": float(f.get("quantity") or 0), "reserved": float(f.get("reserved") or 0), "status": f["status"],
                         "verified_at": f.get("verified_date") or dt.date.fromtimestamp(rec.get("reported_date", 0) / 1000).isoformat(),
                         "verified_by": f.get("actor", ""), "source": "readiness record in CHT"})
    for r in out.values():
        if r["status"] == "confirmed" and r["verified_at"]:
            age = (dt.date.fromisoformat(day) - dt.date.fromisoformat(r["verified_at"][:10])).days
            if age > stale_days:
                r["status"] = "stale"
                r["stale_days"] = age
        usable = r["status"] in USABLE or r["status"] == "insufficient"
        r["available"] = max(0.0, r["quantity"] - r["reserved"]) if usable else 0.0
    return out


def requirements(config: dict) -> dict[str, dict]:
    """Per visit type: consumables used per encounter, and equipment a worker must carry to offer the type."""
    req = config.get("service_requirements", {})
    return {t: {"consumables": {k: float(v) for k, v in (spec.get("consumables") or {}).items()},
                "equipment": list(spec.get("equipment") or [])}
            for t, spec in req.items() if t != "note"}


def fuel(config: dict) -> dict | None:
    spec = config.get("fuel_policy")
    if not spec:
        return None
    return {"resource": spec["resource"], "litres_per_travel_minute": float(spec["litres_per_travel_minute"])}
