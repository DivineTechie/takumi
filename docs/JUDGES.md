# TAKUMI (匠): judges' guide

- **Live app**: [https://takumi-cup-2026.web.app](https://takumi-cup-2026.web.app)
- **System status**: [https://takumi-cup-2026.web.app/status](https://takumi-cup-2026.web.app/status)
- **Architecture**: [architecture.md](architecture.md) · **What is live**: [FEATURE_STATUS.md](FEATURE_STATUS.md)

You need only a laptop and (optionally) a phone. No hardware kit is required.

---

## Accounts

| Role | Account | Use it for |
| :--- | :--- | :--- |
| Supervisor | `judge-supervisor@takumi-cup-2026.web.app` | Dashboard, control tower, unit records, trace-back, holds, inspection decisions |
| Trainee (operator) | `judge-trainee@takumi-cup-2026.web.app` | Station Watch, inspection station, gallery, Machine Watch |
| Master | `judge-master@takumi-cup-2026.web.app` | Standard Work Studio (record a task, review, apply review requests) |

Passwords are in the confidential submission form, never in this public repository. On the sign-in screen choose **"Use a test account"**. Any Google account also works and signs in as a trainee.

---

## 1. End-of-line inspection on real parts (2 minutes, any account)

1. Open **Home → Try real parts (VisA)** (`/inspect/gallery`).
2. Pick a product (candles, capsules, PCBs, snacks…). The tiles show real VisA test images; the dataset label is hidden.
3. Press **Inspect Unit**. Gemini Flash-Lite compares the part with 3 known-good references and, if it suspects a defect, Gemini Flash confirms. Only then is the dataset label revealed, with an honest HIT, MISS or FALSE ALARM.
4. Switch the mode between **Few false alarms** (default) and **Catch everything** to see the trade-off.

Images: VisA dataset (Amazon), CC BY 4.0. Every result is labelled PUBLIC DATA. The benchmark behind the default mode is on [/evals](https://takumi-cup-2026.web.app/evals).

## 2. Machine Watch with no wiring (5 minutes, laptop + phone)

1. On the laptop open **Home → Machine test bench** (`/machines/virtual`): simulated machines with a stack light, a parts counter and an alarm screen. Press **Camera view** to hide the controls (double-click to bring them back).
2. On the phone open **Home → Watch machines** (`/machines/watch`), sign in, press **Start camera** and point it at the laptop screen.
3. Tick "test bench machines", choose the number of machines, press **Find machines with Gemini** (one Gemini Robotics-ER call finds each light, counter and screen), adjust the boxes if needed and **Save**. Press **Start watching**.
4. On the laptop, stop a machine with an alarm (or start a soak run with automatic faults). The phone notices the change locally and asks Gemini Flash-Lite to read the machine; the stop and the alarm text appear within seconds.
5. As supervisor, open **Dashboard → Machines** for the state timeline, availability, stops and alarms (labelled HOME RIG).

## 3. Station Watch (5 minutes, phone or laptop camera)

1. As trainee, open **Home → Learn a skill**, pick the published lesson and your language.
2. Optionally type a **unit serial** (for example `JUDGE-001`): the session is then recorded on that unit.
3. Do the steps in front of the camera. The coach speaks in your language, points at the right place when you ask "where?", checks each step against visible success criteria, and stops you with a full-screen STOP on a hazard.

## 4. Unit records and quality trace-back (3 minutes, supervisor)

1. Open **Dashboard → End-of-Line Quality → Units** and open a failed unit (or search a serial).
2. The unit page shows every station it went through (with evidence frames for mistakes and safety stops) and every inspection.
3. Press **Trace back**. A Google ADK agent reads the records with three read-only tools and proposes the station and step where the defect most likely started, the other units at risk, and a work-instruction change. Its tool calls are listed.
4. Approve a hold for the units you select, and **Send to the Standard Work Studio** to create a review request for the master. Nothing changes without these approvals.

## 5. Control tower (1 minute, supervisor)

Open **Home → Control tower** (`/control`). Every event (station steps, inspections, decisions, machine events, holds) flows from Cloud Run through Pub/Sub into BigQuery; this page shows the totals per source label (LIVE, HOME RIG, PUBLIC DATA) and a live feed. Events from steps 1 to 4 appear here within about a minute.

## 6. Standard Work Studio (master)

As master, **Home → Teach a skill** records a demonstration; a Google ADK 2 workflow turns it into steps with success criteria, reasons, pointing hints and translations. In the review screen the master edits steps, applies or dismisses review requests from supervisors, and publishes.

---

## Observability

[/status](https://takumi-cup-2026.web.app/status) shows API health, a deep Gemini check and the deployed version. Cloud Monitoring alerts on Gemini unavailability and server errors.

## Tips

- Allow camera and microphone access when the browser asks.
- On a phone speaker, the coach talks and then listens; with headphones you can interrupt it.
- For Machine Watch, keep the laptop screen bright and the phone steady (books work well); avoid strong reflections on the screen.
