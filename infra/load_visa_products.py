"""Load 12 VisA product definitions and upload reference images to Cloud Storage & Firestore.

Public Data: VisA (CC BY 4.0).
Parses defect types from each category's image_anno.csv, uploads 3 known-good reference units,
and registers product schemas in Firestore.
"""

from __future__ import annotations

import argparse
import csv
import glob
import io
import json
import os
from pathlib import Path
import sys
from datetime import datetime, timezone

import firebase_admin
from firebase_admin import firestore
from google.cloud import storage
import jsonschema
from PIL import Image

CATEGORIES_SPEC = {
    "candle": {
        "name": "Candle",
        "description": "White cylindrical candle in clear plastic holder",
        "refs": ["0722", "0123", "0031"],
    },
    "capsules": {
        "name": "Capsules",
        "description": "Blister pack of pharmaceutical capsules (green/white or red/yellow)",
        "refs": ["313", "276", "253"],
    },
    "cashew": {
        "name": "Cashew",
        "description": "Whole raw cashew nuts on dark background",
        "refs": ["076", "419", "057"],
    },
    "chewinggum": {
        "name": "Chewing Gum",
        "description": "Chewing gum pellets in blister packaging",
        "refs": ["380", "420", "303"],
    },
    "fryum": {
        "name": "Fryum",
        "description": "Wheel-shaped dried snack pellets",
        "refs": ["048", "330", "234"],
    },
    "macaroni1": {
        "name": "Macaroni 1",
        "description": "Dry elbow macaroni pieces",
        "refs": ["0038", "0036", "0103"],
    },
    "macaroni2": {
        "name": "Macaroni 2",
        "description": "Dry spiral fusilli pasta pieces",
        "refs": ["0244", "0259", "0567"],
    },
    "pcb1": {
        "name": "PCB 1",
        "description": "Printed circuit board with surface-mount capacitors and chips",
        "refs": ["0678", "0033", "0630"],
    },
    "pcb2": {
        "name": "PCB 2",
        "description": "Printed circuit board with connectors, traces and solder joints",
        "refs": ["0223", "0816", "0736"],
    },
    "pcb3": {
        "name": "PCB 3",
        "description": "Printed circuit board with discrete resistors, ICs and headers",
        "refs": ["0798", "0609", "0467"],
    },
    "pcb4": {
        "name": "PCB 4",
        "description": "Complex multi-layer printed circuit board assembly",
        "refs": ["0246", "0503", "0664"],
    },
    "pipe_fryum": {
        "name": "Pipe Fryum",
        "description": "Cylindrical hollow tube dried snack pellets",
        "refs": ["156", "458", "495"],
    },
}


def get_repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def parse_defect_types(anno_csv_path: Path) -> list[str]:
    """Parses unique defect types in order of appearance from image_anno.csv."""
    defect_types: list[str] = []
    seen: set[str] = set()

    if not anno_csv_path.is_file():
        return defect_types

    with open(anno_csv_path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            raw_label = row.get("label", "").strip()
            if not raw_label:
                continue
            for part in raw_label.split(","):
                cleaned = part.strip()
                if not cleaned or cleaned.lower() in ("normal", "other"):
                    continue
                if cleaned not in seen:
                    seen.add(cleaned)
                    defect_types.append(cleaned)

    return defect_types


def resize_image_jpeg(file_path: Path, max_long_side: int = 1024, quality: int = 90) -> bytes:
    """Resizes image maintaining aspect ratio so max long side is max_long_side, at quality."""
    with Image.open(file_path) as img:
        img = img.convert("RGB")
        w, h = img.size
        long_side = max(w, h)
        if long_side > max_long_side:
            scale = max_long_side / float(long_side)
            new_w = max(1, int(round(w * scale)))
            new_h = max(1, int(round(h * scale)))
            img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=quality)
        return buf.getvalue()


def find_ref_file(category_dir: Path, ref_id: str) -> Path:
    """Finds the normal image matching ref_id inside category_dir."""
    candidates = list(category_dir.glob(f"**/Images/Normal/*{ref_id}*"))
    if not candidates:
        candidates = list(category_dir.glob(f"**/*{ref_id}*"))
    img_candidates = [c for c in candidates if c.suffix.lower() in (".jpg", ".jpeg", ".png")]
    if not img_candidates:
        raise FileNotFoundError(f"Reference file '{ref_id}' not found in {category_dir}")
    return img_candidates[0]


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed VisA products into Firestore and Cloud Storage")
    parser.add_argument(
        "--visa-dir",
        type=Path,
        default=Path(os.environ.get("VISA_DATA_DIR", "data/VisA")),
        help="Path to VisA dataset root directory",
    )
    parser.add_argument("--project", default=os.getenv("GCP_PROJECT", "takumi-cup-2026"), help="GCP project ID")
    parser.add_argument(
        "--bucket",
        default=os.getenv("FIREBASE_STORAGE_BUCKET", "takumi-cup-2026.firebasestorage.app"),
        help="Cloud Storage bucket name",
    )
    parser.add_argument("--force", action="store_true", help="Overwrite existing products in Firestore & Storage")
    args = parser.parse_args()

    repo_root = get_repo_root()
    schema_path = repo_root / "shared" / "schema" / "products.json"
    with open(schema_path, "r", encoding="utf-8") as f:
        product_schema = json.load(f)

    if not args.visa_dir.is_dir():
        print(f"Error: VisA directory {args.visa_dir} does not exist.", file=sys.stderr)
        sys.exit(1)

    # Initialize Firebase Admin & Cloud Storage
    if not firebase_admin._apps:
        firebase_admin.initialize_app(options={"projectId": args.project})

    db = firestore.client()
    products_col = db.collection("products")
    storage_client = storage.Client(project=args.project)
    bucket = storage_client.bucket(args.bucket)

    now_iso = datetime.now(timezone.utc).isoformat()
    total_loaded = 0

    for cat_id, spec in CATEGORIES_SPEC.items():
        cat_dir = args.visa_dir / cat_id
        if not cat_dir.is_dir():
            print(f"Warning: Category directory {cat_dir} not found. Skipping.", file=sys.stderr)
            continue

        doc_ref = products_col.document(cat_id)
        doc = doc_ref.get()
        if doc.exists and not args.force:
            print(f"Skipping existing product '{cat_id}' (use --force to overwrite)")
            continue

        print(f"Processing category '{cat_id}'...")
        anno_path = cat_dir / "image_anno.csv"
        defect_types = parse_defect_types(anno_path)

        # Upload 3 reference images
        ref_paths: list[str] = []
        for i, ref_id in enumerate(spec["refs"]):
            ref_file = find_ref_file(cat_dir, ref_id)
            jpeg_bytes = resize_image_jpeg(ref_file)

            blob_path = f"products/{cat_id}/ref_{i+1}.jpg"
            blob = bucket.blob(blob_path)
            blob.upload_from_string(jpeg_bytes, content_type="image/jpeg")
            ref_paths.append(blob_path)
            print(f"  Uploaded reference {i+1} from {ref_file.name} to {blob_path}")

        product_data = {
            "id": cat_id,
            "name": spec["name"],
            "description": spec["description"],
            "defect_types": defect_types,
            "reference_image_paths": ref_paths,
            "default_mode": "few_false_alarms",
            "source": "PUBLIC DATA: VisA (CC BY 4.0)",
            "created_at": now_iso,
        }

        # Validate against JSON schema
        jsonschema.validate(instance=product_data, schema=product_schema)

        # Write to Firestore
        doc_ref.set(product_data)
        print(f"Successfully seeded product '{cat_id}' with {len(defect_types)} defect types.")
        total_loaded += 1

    print(f"\nDone: {total_loaded} products seeded into Firestore and Cloud Storage.")


if __name__ == "__main__":
    main()
