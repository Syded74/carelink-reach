import itertools
import random

from carelink_oi import optimizer, routing, synthetic


def test_ortools_routing_matches_exhaustive_orders_on_demo_matrix():
    travel = optimizer.travel_lookup(synthetic.TRAVEL)
    villages = ["village-a", "village-b", "village-c"]
    for k in range(1, 4):
        for subset in itertools.combinations(villages, k):
            enumerated = min(optimizer.trip_options(list(subset), travel, "facility", k), key=lambda o: -len(o["stops"]))
            routed = routing.shortest_round_trip("facility", list(subset), travel)
            assert routed["travel"] == enumerated["travel"], subset


def test_routing_is_optimal_on_random_seven_stop_matrices():
    rng = random.Random(7)
    for _ in range(3):
        places = ["facility"] + [f"c{i}" for i in range(7)]
        matrix = {a: {b: rng.randint(10, 90) for b in places[i + 1:]} for i, a in enumerate(places)}
        travel = optimizer.travel_lookup(matrix)
        best = min(sum([travel("facility", p[0])] + [travel(a, b) for a, b in zip(p, p[1:])] + [travel(p[-1], "facility")])
                   for p in itertools.permutations(places[1:]))
        assert routing.shortest_round_trip("facility", places[1:], travel)["travel"] == best


def test_large_trips_use_routing_and_stay_within_constraints():
    places = ["facility"] + [f"c{i}" for i in range(8)]
    matrix = {a: {b: 10 + (i * 7 + j * 3) % 25 for j, b in enumerate(places) if j > i} for i, a in enumerate(places)}
    demand = [{"community_id": p, "name": p, "pending": 2, "barrier_level": "low", "data_coverage": 1.0} for p in places[1:]]
    worker = {**synthetic.NURSE_1, "hours": {"start": "07:00", "end": "17:00"}}
    resources = {"facility": "facility", "planning_days": [synthetic.DAY], "workers": [worker], "vehicles": [synthetic.MOTORBIKE],
                 "travel_minutes": matrix, "service": {"setup_minutes_per_stop": 5, "minutes_per_followup": 10}, "max_stops_per_trip": 8}
    options = optimizer.trip_options(places[1:], optimizer.travel_lookup(matrix), "facility", 8)
    assert any(o.get("method") == "ortools-routing" for o in options)
    r = optimizer.solve(demand, resources)
    assert r["status"] in ("OPTIMAL", "FEASIBLE")
    assert r["trips"][0]["total_minutes"] <= 600
