"""Reproducible FICTIONAL hackathon dataset: three villages, two years of synthetic weekly history.

Everything here is invented (seeded random numbers). It exists so the forecaster can be exercised
and evaluated; it is not evidence about any real community.
"""
from __future__ import annotations

import datetime as dt
import math

import numpy as np

SEED = 2026
AS_OF = "2026-10-21"
WEEKS = 104

VILLAGES = [
    # id, name, barrier, base weekly workload, rainy-season extra, weekly trend, share of weeks unreported
    ("village-a", "Village A (fictional)", "high", 9.0, 4.0, 0.00, 0.00),
    ("village-b", "Village B (fictional)", "low", 4.0, 1.0, 0.00, 0.00),
    ("village-c", "Village C (fictional)", "high", 5.0, 3.0, 0.03, 0.35),
]
# Shares of the weekly workload, in WORKLOAD_FIELDS order.
SPLIT = {"requests_created": 0.35, "followups_due": 0.35, "missed_appointments": 0.2, "referrals_open": 0.1}
CURRENT = {"village-a": (12, "2026-09-30"), "village-b": (5, "2026-10-14"), "village-c": (9, "2026-08-26")}


def _monday(day: dt.date) -> dt.date:
    return day - dt.timedelta(days=day.weekday())


def rainy(day: dt.date) -> bool:
    # Northern Ghana's main rains fall roughly May to October; this is a fictional seasonal effect.
    return 5 <= day.month <= 10


def hackathon_dataset() -> dict:
    rng = np.random.Generator(np.random.PCG64(SEED))
    last = _monday(dt.date.fromisoformat(AS_OF)) - dt.timedelta(weeks=1)
    periods = [last - dt.timedelta(weeks=WEEKS - 1 - i) for i in range(WEEKS)]
    history = []
    for vid, _, barrier, base, wet, trend, missing in VILLAGES:
        for i, start in enumerate(periods):
            season = wet * (0.5 + 0.5 * math.sin(2 * math.pi * (start.timetuple().tm_yday - 120) / 365)) if rainy(start) else 0.0
            mean = max(0.5, base + season + trend * i)
            total = int(rng.poisson(mean))
            parts = rng.multinomial(total, list(SPLIT.values()))
            # Poor connectivity: some weeks never reach the server, more often in the rains.
            unreported = rng.random() < (missing * (1.5 if rainy(start) else 0.7))
            row = {"community_id": vid, "period_start": start.isoformat(), "reported": not unreported,
                   "visits_completed": int(rng.poisson(1.0 if barrier == "high" else 1.5)),
                   "transport_barriers": int(rng.poisson(2.0 if barrier == "high" else 0.3) if not unreported else 0)}
            row.update({name: (0 if unreported else int(n)) for name, n in zip(SPLIT, parts)})
            history.append(row)
    return {
        "dataset_id": "hackathon-villages", "label": "Hackathon scenario: Villages A, B, C (synthetic history)",
        "synthetic": True, "exported_at": f"{AS_OF}T00:00:00Z", "source": f"carelink_oi.synthetic seed {SEED}",
        "period": "week", "as_of": AS_OF,
        "communities": [{"id": v[0], "name": v[1], "barrier_level": v[2]} for v in VILLAGES],
        "history": history,
        "current": [{"community_id": vid, "as_of": AS_OF, "pending_followups": n, "urgent_items_excluded": 0, "last_visit": last_visit}
                    for vid, (n, last_visit) in CURRENT.items()],
        "notes": ["All values are synthetic and fictional. Village C misses about a third of weeks to simulate poor connectivity."],
    }


TRAVEL = {
    "facility": {"village-a": 45, "village-b": 20, "village-c": 60},
    "village-a": {"village-b": 30, "village-c": 40},
    "village-b": {"village-c": 50},
}
SERVICE = {"setup_minutes_per_stop": 20, "minutes_per_followup": 15}
DAY = "2026-10-22"
NURSE_1 = {"id": "nurse-1", "name": "Nurse 1 (fictional)", "role": "nurse", "available_days": [DAY],
           "hours": {"start": "08:00", "end": "14:00"}, "communities": [], "qualifications": ["routine_followup"]}
NURSE_2 = {**NURSE_1, "id": "nurse-2", "name": "Nurse 2 (fictional)"}
MOTORBIKE = {"id": "motorbike-1", "name": "Motorbike (fictional)", "available_days": [DAY]}
PICKUP = {"id": "pickup-1", "name": "Pickup (fictional)", "available_days": [DAY]}


def scenario(name: str) -> dict:
    base = {"facility": "facility", "planning_days": [DAY], "workers": [NURSE_1], "vehicles": [MOTORBIKE],
            "travel_minutes": TRAVEL, "service": SERVICE, "max_stops_per_trip": 3, "confirmed_assignments": []}
    variants = {
        "baseline": ("1 nurse, 1 motorbike, 6 hours, 1 day", {}),
        "longer-day": ("1 nurse, 1 motorbike, 8 hours", {"workers": [{**NURSE_1, "hours": {"start": "08:00", "end": "16:00"}}]}),
        "second-nurse-no-vehicle": ("2 nurses, still 1 motorbike, 6 hours", {"workers": [NURSE_1, NURSE_2]}),
        "second-nurse-second-vehicle": ("2 nurses, motorbike + pickup, 6 hours", {"workers": [NURSE_1, NURSE_2], "vehicles": [MOTORBIKE, PICKUP]}),
        "infeasible-confirmed": ("Confirmed full Village C visit in a 3-hour day",
                                 {"workers": [{**NURSE_1, "hours": {"start": "08:00", "end": "11:00"}}],
                                  "confirmed_assignments": [{"worker": "nurse-1", "day": DAY, "community": "village-c", "min_followups": 9}]}),
    }
    label, override = variants[name]
    return {**base, **override, "label": label, "scenario": name}


SCENARIOS = ["baseline", "longer-day", "second-nurse-no-vehicle", "second-nurse-second-vehicle", "infeasible-confirmed"]


def with_demo_history(live: dict) -> dict:
    """Attach the seeded synthetic history to the communities of a live CHT export (FICTIONAL demo).

    Communities take the village profiles in id order (A, B, C). Live weeks always win over
    synthetic ones, and the dataset is labelled synthetic so no screen presents it as real history.
    """
    synth = hackathon_dataset()
    # Past weeks come from the synthetic history; the current week comes from live CHT records.
    first_live = _monday(dt.date.fromisoformat(live["as_of"])).isoformat()
    live = {**live, "history": [r for r in live["history"] if r["period_start"] >= first_live]}
    live_weeks = {(r["community_id"], r["period_start"]) for r in live["history"]}
    profiles = [v[0] for v in VILLAGES]
    # Profiles repeat when a facility has more communities than there are profiles.
    mapping = {c["id"]: profiles[i % len(profiles)] for i, c in enumerate(sorted(live["communities"], key=lambda c: c["id"]))}
    history = [{**r, "community_id": cid} for cid, profile in mapping.items() for r in synth["history"]
               if r["community_id"] == profile and r["period_start"] < first_live and (cid, r["period_start"]) not in live_weeks]
    return {**live, "dataset_id": f"{live['dataset_id']}+simulated-history", "synthetic": True,
            "label": f"{live['label']} + simulated history",
            "history": history + live["history"],
            "notes": list(live.get("notes", [])) + [f"Weeks before {first_live} are simulated (seed {SEED}), not real reporting."]}
