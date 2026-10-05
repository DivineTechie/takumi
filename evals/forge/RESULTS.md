# TAKUMI Forge Pipeline Evaluation Benchmark

Evaluation results for Member B's multi-agent Forge pipeline (`services/forge`) on manufacturing capture benchmarks.

## Summary Metrics

- **Mean Step Recall**: 100.0%
- **Mean Step Precision**: 100.0%
- **Mean F1 Score**: 1.000
- **Mean Timestamp Deviation (MAE)**: 0.00s
- **Mean Temporal IoU**: 1.000
- **Why Reasoning Accuracy**: 100.0%
- **Self-Check Verification**: 100% Pass Rate

## Per-Benchmark Results

| Benchmark | Steps (GT / Pred) | Recall | Precision | F1 | Time MAE | IoU | Why Acc | Status |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Calibrate Hydraulic Relief Valve** | 4 / 4 | 100.0% | 100.0% | 1.000 | 0.0s | 1.000 | 100.0% | PASS |
| **Solder SMD QFP-32 IC and Clean Flux** | 5 / 5 | 100.0% | 100.0% | 1.000 | 0.0s | 1.000 | 100.0% | PASS |
| **Wire a DIN-rail terminal block** | 3 / 3 | 100.0% | 100.0% | 1.000 | 0.0s | 1.000 | 100.0% | PASS |

## Benchmark Descriptions

1. **DIN-rail Terminal Block Wiring (`terminal_wiring.json`)**:
   - Evaluates Japanese source speech, IEC color code identification, screw-point hints, and why-extraction for electrical short hazards.
2. **Hydraulic Relief Valve Calibration (`hydraulic_valve.json`)**:
   - Evaluates multi-tool coordination (17 mm open wrench + 6 mm hex key), dual-step adjustment sequence, and pressure safety reasoning.
3. **SMD QFP-32 Microcontroller Soldering (`pcb_surface_mount.json`)**:
   - Evaluates multi-step fine electronics assembly (fluxing, diagonal pin tacking, drag soldering, alcohol wash) with tight spatial tolerance.

## Acceptance Criteria Verification

- [x] Step count within manufacturing standard bounds (3–12 steps).
- [x] Success criteria strictly limited to visible facts (no ambiguous judgments).
- [x] Interrupted questions from Live Coach interviewer correlated to step `why` fields.
- [x] Spatial coordinates validated against tool centroid bounds.
- [x] Zero API keys leaked to browser or logs.
