# TAKUMI End-of-Line Quality Inspection — Smoke run (24 images), not a benchmark

- **Dataset**: VisA (Visual Anomaly Benchmark, CC BY 4.0)
- **Backend**: `gemini_api`
- **Inspection Mode**: `few_false_alarms`
- **Pipeline**: Dual-Stage Multimodal Vision (Stage 1: `gemini-3.5-flash-lite` with 3 references, Stage 2: `gemini-3.8-flash`)
- **Total Categories Evaluated**: 12
- **Total Units Evaluated**: 24

## Overall Benchmark Summary

| Metric | Value |
| :--- | :--- |
| **Overall Accuracy** | 91.7% (22/24) |
| **Precision** | 100.0% |
| **Recall (Defect Detection)** | 83.3% |
| **F1 Score** | 0.909 |
| **p50 Latency** | 3496 ms |
| **p90 Latency** | 9336 ms |

## Per-Category Results Breakdown

| Category | Units | Normal | Anomaly | Accuracy | Precision | Recall | F1 | p50 Latency |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `candle` | 2 | 1 | 1 | 50.0% | 100.0% | 0.0% | 0.000 | 3050 ms |
| `capsules` | 2 | 1 | 1 | 50.0% | 100.0% | 0.0% | 0.000 | 3290 ms |
| `cashew` | 2 | 1 | 1 | 100.0% | 100.0% | 100.0% | 1.000 | 7326 ms |
| `chewinggum` | 2 | 1 | 1 | 100.0% | 100.0% | 100.0% | 1.000 | 5156 ms |
| `fryum` | 2 | 1 | 1 | 100.0% | 100.0% | 100.0% | 1.000 | 4453 ms |
| `macaroni1` | 2 | 1 | 1 | 100.0% | 100.0% | 100.0% | 1.000 | 5494 ms |
| `macaroni2` | 2 | 1 | 1 | 100.0% | 100.0% | 100.0% | 1.000 | 6262 ms |
| `pcb1` | 2 | 1 | 1 | 100.0% | 100.0% | 100.0% | 1.000 | 6270 ms |
| `pcb2` | 2 | 1 | 1 | 100.0% | 100.0% | 100.0% | 1.000 | 6165 ms |
| `pcb3` | 2 | 1 | 1 | 100.0% | 100.0% | 100.0% | 1.000 | 5287 ms |
| `pcb4` | 2 | 1 | 1 | 100.0% | 100.0% | 100.0% | 1.000 | 5591 ms |
| `pipe_fryum` | 2 | 1 | 1 | 100.0% | 100.0% | 100.0% | 1.000 | 4532 ms |

## Sample Evaluation Details

| Category | Image | Ground Truth | AI Verdict | Detected Defect | Match | Latency |
| :--- | :--- | :--- | :--- | :--- | :---: | :---: |
| `candle` | `0000.JPG` | normal | `ok` | — | **PASSED** | 2837 ms |
| `candle` | `000.JPG` | chunk of wax missing | `ok` | — | **FAILED** | 3262 ms |
| `capsules` | `000.JPG` | normal | `ok` | — | **PASSED** | 3854 ms |
| `capsules` | `000.JPG` | bubble | `ok` | — | **FAILED** | 2727 ms |
| `cashew` | `000.JPG` | normal | `ok` | — | **PASSED** | 3135 ms |
| `cashew` | `000.JPG` | burnt,corner or edge breakage | `defective` | different colour spot | **PASSED** | 11518 ms |
| `chewinggum` | `000.JPG` | normal | `ok` | — | **PASSED** | 2742 ms |
| `chewinggum` | `000.JPG` | chunk of gum missing,scratches,small cracks | `defective` | chunk of gum missing | **PASSED** | 7569 ms |
| `fryum` | `000.JPG` | normal | `ok` | — | **PASSED** | 2764 ms |
| `fryum` | `000.JPG` | burnt | `defective` | burnt | **PASSED** | 6142 ms |
| `macaroni1` | `0000.JPG` | normal | `ok` | — | **PASSED** | 2914 ms |
| `macaroni1` | `000.JPG` | chip around edge and corner | `defective` | chip around edge and corner | **PASSED** | 8074 ms |
| `macaroni2` | `0000.JPG` | normal | `ok` | — | **PASSED** | 3258 ms |
| `macaroni2` | `000.JPG` | breakage down the middle,small scratches | `defective` | small hole | **PASSED** | 9267 ms |
| `pcb1` | `0000.JPG` | normal | `ok` | — | **PASSED** | 3134 ms |
| `pcb1` | `000.JPG` | bent | `defective` | bent | **PASSED** | 9405 ms |
| `pcb2` | `0000.JPG` | normal | `ok` | — | **PASSED** | 3729 ms |
| `pcb2` | `000.JPG` | bent | `defective` | bent | **PASSED** | 8601 ms |
| `pcb3` | `0000.JPG` | normal | `ok` | — | **PASSED** | 2789 ms |
| `pcb3` | `000.JPG` | bent | `defective` | bent | **PASSED** | 7785 ms |
| `pcb4` | `0000.JPG` | normal | `ok` | — | **PASSED** | 2682 ms |
| `pcb4` | `000.JPG` | burnt,scratch,dirt | `defective` | burnt | **PASSED** | 8500 ms |
| `pipe_fryum` | `000.JPG` | normal | `ok` | — | **PASSED** | 2603 ms |
| `pipe_fryum` | `000.JPG` | burnt | `defective` | different colour spot | **PASSED** | 6461 ms |
