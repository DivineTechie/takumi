"""Cost Guard for TAKUMI load testing and benchmarking.

Enforces:
1. --max-calls (default 50) bounding the total API calls executed in a run.
2. Refuses default-thinking verify runs above 20 calls without --i-know-this-costs flag.
"""

import argparse
import sys


def add_cost_guard_args(parser: argparse.ArgumentParser, default_max_calls: int = 50) -> None:
    """Adds standard cost guard CLI arguments."""
    parser.add_argument(
        "--max-calls",
        type=int,
        default=default_max_calls,
        help=f"Maximum allowed API calls for this run (default: {default_max_calls})",
    )
    parser.add_argument(
        "--i-know-this-costs",
        action="store_true",
        help="Explicitly acknowledge and permit default-thinking verify runs above 20 calls",
    )


def enforce_cost_guard(
    total_calls: int,
    max_calls: int = 50,
    is_default_thinking_verify: bool = False,
    i_know_this_costs: bool = False,
) -> None:
    """Validates cost guard constraints. Raises SystemExit(2) on guard violation."""
    if total_calls > max_calls:
        print(
            f"ERROR [CostGuard]: Planned call count ({total_calls}) exceeds --max-calls limit ({max_calls}). "
            f"Aborting run to prevent excessive billing.",
            file=sys.stderr,
        )
        sys.exit(2)

    if is_default_thinking_verify and total_calls > 20 and not i_know_this_costs:
        print(
            f"ERROR [CostGuard]: Default-thinking verify runs above 20 calls ({total_calls} requested) "
            f"generate high token costs and are blocked. Provide --i-know-this-costs to override.",
            file=sys.stderr,
        )
        sys.exit(2)
