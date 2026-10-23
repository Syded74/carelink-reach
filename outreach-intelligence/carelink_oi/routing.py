"""Visit sequencing with the OR-Tools routing solver (pywrapcp), after the OR-Tools VRP/TSP examples.

The CP-SAT model in optimizer.py decides who goes where and how many items each visit covers;
routing only orders the stops of one round trip. For trips of up to ENUMERATE_UP_TO stops,
optimizer.py tries every order, which is exact. Above that, the number of orders explodes and this
solver is used instead. tests/test_routing.py checks both agree where both can run.
"""
from __future__ import annotations

from ortools.constraint_solver import pywrapcp, routing_enums_pb2

ENUMERATE_UP_TO = 6


def shortest_round_trip(facility: str, stops: list[str], travel, time_limit_s: int = 2) -> dict:
    nodes = [facility, *stops]
    manager = pywrapcp.RoutingIndexManager(len(nodes), 1, 0)
    routing = pywrapcp.RoutingModel(manager)
    cost = routing.RegisterTransitCallback(lambda i, j: travel(nodes[manager.IndexToNode(i)], nodes[manager.IndexToNode(j)]))
    routing.SetArcCostEvaluatorOfAllVehicles(cost)
    params = pywrapcp.DefaultRoutingSearchParameters()
    params.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    if len(stops) > ENUMERATE_UP_TO:
        params.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
        params.time_limit.seconds = time_limit_s
    solution = routing.SolveWithParameters(params)
    if solution is None:
        raise RuntimeError("Routing solver found no round trip")
    order, index = [], routing.Start(0)
    while not routing.IsEnd(index):
        node = manager.IndexToNode(index)
        if node:
            order.append(nodes[node])
        index = solution.Value(routing.NextVar(index))
    legs = [travel(facility, order[0])] + [travel(a, b) for a, b in zip(order, order[1:])] + [travel(order[-1], facility)]
    return {"stops": tuple(order), "travel": sum(legs), "legs": legs, "method": "ortools-routing"}
