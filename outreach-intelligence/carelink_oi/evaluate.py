"""Reproducible fictional model and resource-comparison evidence; no CHT writes."""
from __future__ import annotations
import json
from pathlib import Path
from . import FORECAST_VERSION, PLANNER_VERSION, data_adapter, model_comparison, optimizer, synthetic


def main():
    evidence = Path(__file__).resolve().parents[2] / 'evidence'
    evidence.mkdir(exist_ok=True)
    comparison = model_comparison.compare(data_adapter.parse(synthetic.hackathon_dataset()))
    comparison['model_version'] = FORECAST_VERSION
    (evidence / 'oi-model-comparison.json').write_text(json.dumps(comparison, indent=2) + '\n')
    demand = [
        {'community_id': 'village-a', 'name': 'A (fictional)', 'pending': 12, 'barrier_level': 'high', 'data_coverage': 1.0},
        {'community_id': 'village-b', 'name': 'B (fictional)', 'pending': 5, 'barrier_level': 'low', 'data_coverage': 1.0},
        {'community_id': 'village-c', 'name': 'C (fictional)', 'pending': 9, 'barrier_level': 'high', 'data_coverage': .58},
    ]
    scenarios = {}
    for name in ['baseline', 'longer-day', 'second-nurse-no-vehicle', 'second-nurse-second-vehicle', 'infeasible-confirmed']:
        result = optimizer.solve(demand, synthetic.scenario(name))
        if result['status'] in ['OPTIMAL', 'FEASIBLE']:
            assert all(t['total_minutes'] <= t['available_minutes'] for t in result['trips'])
            assert len({(t['day'], t['vehicle']) for t in result['trips']}) == len(result['trips'])
            assert len({(t['day'], t['worker']) for t in result['trips']}) == len(result['trips'])
        scenarios[name] = result
    output = {'fictional_data_only': True, 'planner_version': PLANNER_VERSION,
              'note': 'Resource counterfactuals hold demand and fairness constant. They are not evidence of real-world or clinical improvement.',
              'scenarios': scenarios}
    (evidence / 'oi-solver-regression.json').write_text(json.dumps(output, indent=2) + '\n')
    print(json.dumps({'baseline': comparison['baseline_method'], 'model_decision': comparison['decision'],
                      'solver': {k: {'status': v['status'], 'served': sum(v['served'].values()), 'weighted_served': v.get('weighted_served')} for k, v in scenarios.items()}}, indent=2))


if __name__ == '__main__':
    main()
