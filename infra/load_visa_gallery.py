"""Load the VisA gallery (5 normal + 5 anomalous test images per category, 12 categories) into Cloud Storage and Firestore.

Public Data: VisA (CC BY 4.0).
Uses fixed seed 42 to sample 5 normal and 5 anomalous images from the VisA test split for all 12 categories,
strictly excluding the 3 reference images per category.

Nothing visible to the browser may reveal the label:
- Firestore doc ids are opaque: gal_<secrets.token_hex(6)>.
- Storage objects are opaque: gallery/<secrets.token_hex(6)>.jpg (no category, no label, no source filename).
- The dataset label and the source filename are stored ONLY in the Firestore gallery/{id} doc, which the
  API never returns before inspection.

Images are resized to max 1024 px JPEG (quality 90).
Run with --purge to delete every existing gallery doc and every object under gallery/ before reseeding.
"""

from __future__ import annotations

import argparse
import csv
import io
import os
from pathlib import Path
import random
import secrets
import sys
from datetime import datetime, timezone

import firebase_admin
from firebase_admin import firestore
from google.cloud import storage
from PIL import Image

CATEGORIES = [
    "candle",
    "capsules",
    "cashew",
    "chewinggum",
    "fryum",
    "macaroni1",
    "macaroni2",
    "pcb1",
    "pcb2",
    "pcb3",
    "pcb4",
    "pipe_fryum",
]

REFS_TO_EXCLUDE: dict[str, list[str]] = {
    "candle": ["0722", "0123", "0031"],
    "capsules": ["313", "276", "253"],
    "cashew": ["076", "419", "057"],
    "chewinggum": ["380", "420", "303"],
    "fryum": ["048", "330", "234"],
    "macaroni1": ["0038", "0036", "0103"],
    "macaroni2": ["0244", "0259", "0567"],
    "pcb1": ["0678", "0033", "0630"],
    "pcb2": ["0223", "0816", "0736"],
    "pcb3": ["0798", "0609", "0467"],
    "pcb4": ["0246", "0503", "0664"],
    "pipe_fryum": ["156", "458", "495"],
}


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


def load_category_annotations(visa_dir: Path, category: str) -> dict[str, str]:
    """Loads mapping from normalized image path to defect label from image_anno.csv."""
    anno_path = visa_dir / category / "image_anno.csv"
    mapping: dict[str, str] = {}
    if not anno_path.is_file():
        return mapping

    with open(anno_path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            raw_path = row.get("image", "").strip().replace("\\", "/")
            label = row.get("label", "").strip()
            if raw_path:
                mapping[raw_path] = label
    return mapping


def sample_gallery(visa_dir: Path, seed: int, per_class: int) -> list[tuple[str, str, str]]:
    """Returns the deterministic (category, item_type, rel_img_path) sample for the given seed."""
    cls_csv_path = visa_dir / "1cls.csv"
    category_test_splits: dict[str, dict[str, list[str]]] = {
        cat: {"normal": [], "anomaly": []} for cat in CATEGORIES
    }
    with open(cls_csv_path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            cat = row.get("object", "").strip()
            split = row.get("split", "").strip()
            label = row.get("label", "").strip()
            img_rel = row.get("image", "").strip().replace("\\", "/")
            if cat in category_test_splits and split == "test" and label in ("normal", "anomaly"):
                category_test_splits[cat][label].append(img_rel)

    rng = random.Random(seed)
    out: list[tuple[str, str, str]] = []
    for cat in CATEGORIES:
        refs = REFS_TO_EXCLUDE.get(cat, [])
        normal_candidates = sorted(
            img for img in category_test_splits[cat]["normal"] if not any(ref in img for ref in refs)
        )
        anomaly_candidates = sorted(
            img for img in category_test_splits[cat]["anomaly"] if not any(ref in img for ref in refs)
        )
        if len(normal_candidates) < per_class or len(anomaly_candidates) < per_class:
            print(f"Error: Not enough candidates for {cat}", file=sys.stderr)
            continue
        sampled_normal = rng.sample(normal_candidates, per_class)
        sampled_anomaly = rng.sample(anomaly_candidates, per_class)
        out.extend((cat, "normal", p) for p in sampled_normal)
        out.extend((cat, "anomaly", p) for p in sampled_anomaly)
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed VisA gallery into Firestore and Cloud Storage")
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
    parser.add_argument("--seed", type=int, default=42, help="Random seed for sampling (default: 42)")
    parser.add_argument("--samples-per-class", type=int, default=5, help="Number of samples per class (default: 5)")
    parser.add_argument(
        "--purge",
        action="store_true",
        help="Delete every gallery doc and every object under gallery/ before reseeding",
    )
    args = parser.parse_args()

    if not args.visa_dir.is_dir():
        print(f"Error: VisA directory {args.visa_dir} does not exist.", file=sys.stderr)
        sys.exit(1)
    if not (args.visa_dir / "1cls.csv").is_file():
        print(f"Error: 1cls.csv not found in {args.visa_dir}", file=sys.stderr)
        sys.exit(1)

    if not firebase_admin._apps:
        firebase_admin.initialize_app(options={"projectId": args.project})

    db = firestore.client()
    gallery_col = db.collection("gallery")
    storage_client = storage.Client(project=args.project)
    bucket = storage_client.bucket(args.bucket)

    if args.purge:
        # Old doc ids / object names leaked labels (e.g. gallery/candle/anomaly_013.jpg): delete them all.
        deleted_docs = 0
        for d in gallery_col.stream():
            d.reference.delete()
            deleted_docs += 1
        deleted_blobs = 0
        for blob in storage_client.list_blobs(args.bucket, prefix="gallery/"):
            blob.delete()
            deleted_blobs += 1
        print(f"Purged {deleted_docs} gallery docs and {deleted_blobs} gallery objects.")
    elif any(True for _ in gallery_col.limit(1).stream()):
        print("Gallery already seeded. Use --purge to delete and reseed.", file=sys.stderr)
        sys.exit(1)

    sample = sample_gallery(args.visa_dir, args.seed, args.samples_per_class)
    print(f"Seed={args.seed}: sampled {len(sample)} images across {len(CATEGORIES)} categories.")

    anno_cache: dict[str, dict[str, str]] = {}
    now_iso = datetime.now(timezone.utc).isoformat()
    total_uploaded = 0

    for cat, item_type, rel_img_path in sample:
        full_img_path = args.visa_dir / rel_img_path.replace("/", os.sep)
        if not full_img_path.is_file():
            print(f"Warning: a sampled file for {cat} is missing. Skipping.", file=sys.stderr)
            continue

        if cat not in anno_cache:
            anno_cache[cat] = load_category_annotations(args.visa_dir, cat)

        # Opaque ids. secrets (not the seeded rng) so the sample stays identical across reseeds.
        doc_id = f"gal_{secrets.token_hex(6)}"
        storage_path = f"gallery/{secrets.token_hex(6)}.jpg"

        # Ground truth: the dataset's own defect label for anomalies, else 'normal'
        ground_truth = anno_cache[cat].get(rel_img_path)
        if not ground_truth or ground_truth.lower() == "normal":
            ground_truth = "normal" if item_type == "normal" else "anomaly"

        jpeg_bytes = resize_image_jpeg(full_img_path, max_long_side=1024, quality=90)
        bucket.blob(storage_path).upload_from_string(jpeg_bytes, content_type="image/jpeg")

        # Label + source filename live only in this doc; the API never returns them before inspection.
        gallery_col.document(doc_id).set({
            "id": doc_id,
            "product_id": cat,
            "image_path": storage_path,
            "label": ground_truth,
            "source_file": rel_img_path,
            "split": "test",
            "source": "PUBLIC DATA: VisA (CC BY 4.0)",
            "created_at": now_iso,
        })
        total_uploaded += 1

    print(f"Done. Loaded {total_uploaded} gallery images into Cloud Storage & Firestore.")


if __name__ == "__main__":
    main()
