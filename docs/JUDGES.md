# TAKUMI (匠): judges' guide

- **Live app**: [https://takumi-cup-2026.web.app](https://takumi-cup-2026.web.app)
- **System status**: [https://takumi-cup-2026.web.app/status](https://takumi-cup-2026.web.app/status)
- **No sign-in needed**: [product tour](https://takumi-cup-2026.web.app/tour) · [evaluations](https://takumi-cup-2026.web.app/evals)
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
4. On the laptop, stop a machine with an alarm (or start a soak run with automatic faults). The phone notices the change locally and asks Gemini Flash-Lite to read the machine; the stop and the alarm text appear within seconds. Under each bench machine a stopwatch shows how long TAKUMI took to see the change, measured on the laptop's own clock.
5. As supervisor, open **Home → Quality dashboard → Machines** for the state timeline, availability, stops and alarms (labelled HOME RIG).

## 3. Station Watch (5 minutes, phone or laptop camera)

1. As trainee, open **Home → Start Station Watch**, pick a work instruction and your language.
2. Optionally type a **unit serial** (for example `JUDGE-001`): the session is then recorded on that unit.
3. Do the steps in front of the camera. The coach speaks in your language, points at the right place when you ask "where?", checks each step against visible success criteria, and stops you with a full-screen STOP on a hazard.

## 4. Unit records and quality trace-back (3 minutes, supervisor)

1. Open **Home → Quality dashboard** (it opens on **End-of-line quality**) and open a failed unit from the units list (or go to `/units/<serial>`, for example `/units/FIX-0004`).
2. The unit page shows every station it went through (with evidence frames for mistakes and safety stops) and every inspection.
3. Press **Trace back**. A Google ADK agent reads the records with three read-only tools and proposes the station and step where the defect most likely started, the other units at risk, and a work-instruction change. The result is drawn as a graph (failed unit → station and step → units at risk → fix) and its tool calls are listed.
4. Approve a hold for the units you select, and **Send to the Standard Work Studio** to create a review request for the master. Nothing changes without these approvals.

## 5. Control tower, work orders and voice (3 minutes, supervisor)

Open **Home → Control tower** (`/control`). Every event (station steps, inspections, decisions, machine events, holds) flows from Cloud Run through Pub/Sub into BigQuery; this page shows the totals per source label (LIVE, HOME RIG, PUBLIC DATA) and a live feed. Events from steps 1 to 4 appear here within about a minute.

**A machine stops: the work order.** With the test bench from step 2 running, stop a machine. Its card in **Machines now** turns red; press **Draft work order**. A Google ADK maintenance agent reads the machine's state, its stops and alarms over 7 days, the alarm guide and past work orders, and drafts a work order with likely causes and their evidence, steps, safety points and parts (about 20 seconds; each tool call is shown). Pick a language and press **Speak** to hear the floor alert (Gemini TTS), then approve or dismiss.

**Ask TAKUMI.** Press the microphone and ask, in any of the six languages, "Will we make today's orders?" or "Which machine is stopped, and why?". Gemini Live answers by voice; the chips show which data it read. It can ask the maintenance or planner agent, but it cannot approve anything.

**Will we make today's orders?** On the same page, press **New order**, pick the test bench machines from step 2, a quantity and a due time. The order is projected from the real machine counts. Stop a machine on the test bench and press **Will we make it?**: a Google ADK planner agent explains which order is at risk, why, and what you could do. The numbers come from the counts, not from the model, and nothing changes without you.

## 6. Standard Work Studio (master)

As master, **Home → Record a task**: record a short demonstration and say why each step matters. A Google ADK 2 workflow sends the video to Gemini, which writes the steps with visible success criteria and reasons; Gemini Robotics-ER adds a pointing hint per step, a checker flags criteria that are not visible facts, and the steps are translated into five languages. Follow the run live (every step shows its real progress), then review: edit steps, apply or dismiss review requests from supervisors, and publish. A run takes a few minutes; each master can start 10 runs a day.

---

## Observability

[/status](https://takumi-cup-2026.web.app/status) shows API health, a live (cached) Gemini check and 7-day latency percentiles. Cloud Monitoring alerts on API, Gemini and Forge health and on server errors. If /status shows Gemini as degraded, AI features pause while records, dashboards and the gallery history keep working.

## Tips

- Every screen is available in English, 日本語, Tiếng Việt, हिन्दी, Bahasa Indonesia and Filipino (language menu at the top). The translations are machine-made with Gemini and marked for native review.
- Allow camera and microphone access when the browser asks.
- On a phone speaker, the coach talks and then listens; with headphones you can interrupt it.
- For Machine Watch, keep the laptop screen bright and the phone steady (books work well); avoid strong reflections on the screen.
