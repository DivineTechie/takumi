# Infrastructure and tools

| File | What it does |
| :--- | :--- |
| `cloudbuild.yaml` | CI/CD on every push to `main`: API, Forge, web and security-rules tests in parallel, then both containers, both Cloud Run services, Firestore/Storage rules and indexes, and Firebase Hosting |
| `events_pipeline.sh` | Pub/Sub topic `takumi-events`, BigQuery table `takumi.events` and the BigQuery subscription between them |
| `load_seed.py` | Loads the sample work instructions in `shared/seed` into Firestore |
| `load_visa_gallery.py`, `load_visa_products.py` | Load the judges' gallery and reference products from a local VisA copy (`VISA_DATA_DIR`) |
| `set_role.py` | Sets a user's role claim: `python -m infra.set_role <uid-or-email> <trainee\|supervisor\|master>` |
| `translate_i18n.py` | Fills the five non-English UI languages with Gemini (missing or changed keys only) |
| `rules-tests/` | Firestore and Storage security rules tests, run in the Firebase emulator |

Setting up a new project from scratch: [docs/SETUP.md](../docs/SETUP.md).
