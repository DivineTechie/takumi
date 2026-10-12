# Agent scenarios (TEST FIXTURES)

The deployed Google ADK agents, with real Gemini calls, run against in-memory records whose right answer is known. These are scripted test scenarios, not factory data.

| Agent | Scenarios | Checked | Result |
| :--- | :--- | :--- | :--- |
| Maintenance | 6 alarm codes, each as a first stop and as a repeat stop | the most likely cause is one of the alarm guide's causes, repair time, repeat flag, safety steps | **12/12** passed, median 17 s |
| Quality trace-back | 4 failed units with a known root-cause step and known units at risk | the step, the exact hold list, no unsupported hold | **4/4** passed, median 21 s |

Run from the repository root: `python -m evals.agents.run_agent_evals` (`ONLY=maintenance` or `ONLY=traceback` runs one agent). Results are written to `apps/web/src/evals/agentResults.json` and shown on [/evals](https://takumi-cup-2026.web.app/evals).
