"""Load seed skills from shared/seed/*.json into Firestore skills/{id}.

Validates each file against /shared/schema/skills.json before writing.
Skips existing documents unless --force is specified.
Uses Application Default Credentials (ADC).
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys
from pathlib import Path

import firebase_admin
from firebase_admin import firestore
import jsonschema


def get_repo_root() -> Path:
    # infra/load_seed.py -> repo root is parent of infra
    return Path(__file__).resolve().parent.parent


def load_schema(schema_path: Path) -> dict:
    if not schema_path.is_file():
        raise FileNotFoundError(f"Skills schema not found at {schema_path}")
    with open(schema_path, "r", encoding="utf-8") as f:
        return json.load(f)


def load_seeds(seed_dir: Path, schema: dict) -> list[tuple[str, dict]]:
    """Load and validate all JSON files in seed_dir. Returns list of (skill_id, data)."""
    seed_files = sorted(glob.glob(str(seed_dir / "*.json")))
    if not seed_files:
        print(f"No seed JSON files found in {seed_dir}")
        return []

    seeds: list[tuple[str, dict]] = []
    for filepath in seed_files:
        path = Path(filepath)
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)

        # Validate against schema
        try:
            jsonschema.validate(instance=data, schema=schema)
        except jsonschema.ValidationError as err:
            print(f"Error: Schema validation failed for {path.name}: {err.message}", file=sys.stderr)
            sys.exit(1)

        skill_id = data.get("id")
        if not skill_id:
            print(f"Error: Missing 'id' field in {path.name}", file=sys.stderr)
            sys.exit(1)

        seeds.append((skill_id, data))

    return seeds


def main() -> None:
    parser = argparse.ArgumentParser(description="Load seed skills into Firestore")
    parser.add_argument("--force", action="store_true", help="Overwrite existing skills in Firestore")
    parser.add_argument("--project", default=os.getenv("GCP_PROJECT", "takumi-cup-2026"), help="GCP project ID")
    parser.add_argument("--seed-dir", type=Path, default=None, help="Directory containing seed JSON files")
    parser.add_argument("--schema", type=Path, default=None, help="Path to skills.json schema")
    args = parser.parse_args()

    repo_root = get_repo_root()
    seed_dir = args.seed_dir or (repo_root / "shared" / "seed")
    schema_path = args.schema or (repo_root / "shared" / "schema" / "skills.json")

    schema = load_schema(schema_path)
    seeds = load_seeds(seed_dir, schema)

    if not seeds:
        print("Nothing to load.")
        return

    # Initialize Firebase Admin
    if not firebase_admin._apps:
        firebase_admin.initialize_app(options={"projectId": args.project})

    db = firestore.client()
    skills_col = db.collection("skills")

    loaded_count = 0
    skipped_count = 0

    for skill_id, skill_data in seeds:
        doc_ref = skills_col.document(skill_id)
        doc = doc_ref.get()

        if doc.exists and not args.force:
            print(f"Skipping existing skill '{skill_id}' (use --force to overwrite)")
            skipped_count += 1
        else:
            doc_ref.set(skill_data)
            status = "Overwrote" if (doc.exists and args.force) else "Loaded"
            print(f"{status} skill '{skill_id}' ({skill_data.get('title', '')})")
            loaded_count += 1

    print(f"Summary: {loaded_count} loaded, {skipped_count} skipped.")


if __name__ == "__main__":
    main()
