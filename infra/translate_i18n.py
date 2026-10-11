"""Translate the web app's page strings with Gemini.

Reads apps/web/src/i18n/pages/en/<area>.json and fills apps/web/src/i18n/pages/<lang>/<area>.json for
ja, vi, hi, id and fil. Only keys that are missing (or whose English changed since the last run) are
sent. Every translation keeps the {placeholders} of its English string, or it is dropped and the app
falls back to English for that key. Translations are machine-made and marked for native review.

Usage (repo root): python -m infra.translate_i18n [--area ops] [--force]
Needs GEMINI_API_KEY in the environment, or Application Default Credentials that can read the
GEMINI_API_KEY secret in Secret Manager. The key is never printed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path

from google import genai
from google.genai import types

MODEL = "gemini-3.8-flash"
ROOT = Path(__file__).resolve().parents[1] / "apps" / "web" / "src" / "i18n" / "pages"
LANGS = {
    "ja": "Japanese",
    "vi": "Vietnamese",
    "hi": "Hindi (Devanagari script)",
    "id": "Bahasa Indonesia",
    "fil": "Filipino (Tagalog)",
}
KEEP = ["TAKUMI", "LIVE", "HOME RIG", "PUBLIC DATA", "Gemini", "Gemini Live", "Google ADK", "Google", "VisA", "Cloud Run",
        "BigQuery", "Pub/Sub", "Firebase", "Firestore", "Secret Manager", "Model Armor", "OEE", "QR", "HMI", "ID"]
BATCH = 60
PLACEHOLDER = re.compile(r"\{[a-zA-Z0-9_]+\}")
META_KEY = "_source_hashes"

PROMPT = """You translate the user interface of TAKUMI, a factory quality and operations app used by operators and
supervisors on the shop floor, into {language}.
Rules:
- Translate every value. Keep each key unchanged.
- Keep every placeholder in curly braces exactly as written, for example {{n}} or {{name}}.
- Never translate these terms; copy them exactly: {keep}.
- Keep machine alarm codes, model IDs, units like "s", "min", "px" and numbers as they are.
- Use short, plain, natural wording that fits on buttons and labels; the same length as the English or shorter where possible.
- Use the terms a factory worker would use (inspection, defect, work order, station, shift).
- Use the polite but direct register normally used in apps for {language}.
Return a JSON object with exactly the same keys.

Strings:
{strings}"""


def api_key() -> str:
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if key:
        return key
    from google.cloud import secretmanager

    name = f"projects/{os.environ.get('GOOGLE_CLOUD_PROJECT', 'takumi-cup-2026')}/secrets/GEMINI_API_KEY/versions/latest"
    return secretmanager.SecretManagerServiceClient().access_secret_version(request={"name": name}).payload.data.decode().strip()


def digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]


def valid(en: str, tr: object) -> bool:
    return isinstance(tr, str) and tr.strip() != "" and sorted(PLACEHOLDER.findall(en)) == sorted(PLACEHOLDER.findall(tr))


def translate_batch(client: genai.Client, language: str, strings: dict[str, str]) -> dict[str, str]:
    prompt = PROMPT.format(language=language, keep=", ".join(KEEP), strings=json.dumps(strings, ensure_ascii=False, indent=1))
    resp = client.models.generate_content(
        model=MODEL,
        contents=prompt,
        config=types.GenerateContentConfig(response_mime_type="application/json"),
    )
    data = json.loads(resp.text or "{}")
    return {k: v for k, v in data.items() if k in strings and valid(strings[k], v)}


def run(area: str | None, force: bool) -> int:
    client = genai.Client(api_key=api_key(), http_options={"api_version": "v1beta"})
    problems = 0
    for en_file in sorted((ROOT / "en").glob("*.json")):
        if area and en_file.stem != area:
            continue
        en = {k: v for k, v in json.loads(en_file.read_text(encoding="utf-8")).items() if isinstance(v, str)}
        if not en:
            continue
        for code, language in LANGS.items():
            out_file = ROOT / code / en_file.name
            current = json.loads(out_file.read_text(encoding="utf-8")) if out_file.exists() else {}
            hashes = current.pop(META_KEY, {}) if isinstance(current.get(META_KEY), dict) else {}
            todo = {k: v for k, v in en.items() if force or k not in current or hashes.get(k) != digest(v) or not valid(v, current.get(k))}
            items = list(todo.items())
            for i in range(0, len(items), BATCH):
                chunk = dict(items[i:i + BATCH])
                done = translate_batch(client, language, chunk)
                missing = {k: v for k, v in chunk.items() if k not in done}
                if missing:  # one retry for strings that came back wrong
                    done.update(translate_batch(client, language, missing))
                for k in chunk:
                    if k in done:
                        current[k] = done[k]
                        hashes[k] = digest(en[k])
                    else:
                        problems += 1
                        print(f"  {code}/{en_file.stem}: no valid translation for {k}", file=sys.stderr)
            # Drop keys that no longer exist in English.
            current = {k: current[k] for k in en if k in current}
            hashes = {k: hashes[k] for k in current if k in hashes}
            out_file.parent.mkdir(parents=True, exist_ok=True)
            out_file.write_text(json.dumps({**current, META_KEY: hashes}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
            print(f"{code}/{en_file.name}: {len(todo)} translated, {len(current)}/{len(en)} keys")
    return problems


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--area", help="Only this area file (name without .json)")
    parser.add_argument("--force", action="store_true", help="Translate every key again")
    args = parser.parse_args()
    sys.exit(1 if run(args.area, args.force) else 0)
