"""
CLI runner for Forge evaluation suite.
Executes benchmarks against all fixtures and generates RESULTS.md.
"""

import os
import sys
from pathlib import Path

# Add project root to sys.path so services.forge is importable
repo_root = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(repo_root))

# Enable mock models and local dev for deterministic benchmark evaluation
os.environ["MOCK_MODELS"] = "true"
os.environ["LOCAL_DEV"] = "true"

from evals.forge.evaluator import ForgeEvaluator


def main():
    print("Starting TAKUMI Forge multi-agent benchmark evaluation...")
    evaluator = ForgeEvaluator()
    results = evaluator.run_all()
    print(f"Evaluated {len(results)} capture benchmarks.")

    report = evaluator.generate_report(results)
    output_path = Path(__file__).parent / "RESULTS.md"
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(report)

    print(f"Benchmark results successfully written to {output_path}")
    print(report)


if __name__ == "__main__":
    main()
