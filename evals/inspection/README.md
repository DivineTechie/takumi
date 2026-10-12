# End-of-line inspection benchmark (PUBLIC DATA)

The shipped inspection pipeline (same prompt, models, settings and 3 known-good reference images) run on the **VisA 1cls test split: 2,162 images across 12 product categories** (Amazon, CC BY 4.0). Generated 2026-10-11; every image scored.

| Setup | Accuracy (95% CI) | Defects caught | False alarms | Model cost per part |
| :--- | :--- | :--- | :--- | :--- |
| **Few false alarms (default):** Flash-Lite screens, Flash confirms | **88.4% ± 1.4%** | 80.2% | **1.4%** | **$0.0022** |
| Catch everything: defective if either model flags | 83.4% ± 1.6% | 94.3% | 30.2% | $0.0054 |
| Flash-Lite + 3 references only | 88.5% ± 1.3% | 82.8% | 4.4% | $0.0008 |
| Flash on the unit only | 83.3% ± 1.6% | 91.8% | 27.2% | $0.0046 |

The default keeps false alarms low because a real line is 1-5% defective, so every false alarm costs a person's time; a person confirms or overrides every flag in the product.

- `run_eval.py` runs the benchmark (needs a local VisA copy in `VISA_DATA_DIR`).
- `summarise_visa.py` turns a run into [`visa_12cat_per_image.csv`](visa_12cat_per_image.csv) (one row per image) and `apps/web/src/evals/visaResults.json`, which the [/evals](https://takumi-cup-2026.web.app/evals) page shows with per-category results, method and caveats.
