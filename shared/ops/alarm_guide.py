"""Alarm guide for the maintenance agent.

The entries cover the alarm codes shown by the virtual test bench (apps/web/src/lib/benchSchedule.ts).
They were written by the TAKUMI team from general machine-shop practice, not taken from a vendor
manual, and the agent says so. A real factory would load its own machine manuals here.
"""

from __future__ import annotations

import re

GUIDE_SOURCE = "TAKUMI test-bench alarm guide (written by the team, not a vendor manual)"

# Words a machine screen shows when nothing is wrong; never treated as alarms.
STATUS_WORDS = {"", "NONE", "NULL", "NO ALARM", "NORMAL", "CLEAR", "OK", "RUNNING", "RUN", "IDLE", "STOPPED", "STOP", "READY", "AUTO", "MANUAL", "STANDBY"}

ALARM_GUIDE: dict[str, dict[str, list[str] | str]] = {
    "E-104": {
        "title": "Spindle overload",
        "likely_causes": [
            "Dull or chipped cutting tool",
            "Feed rate or depth of cut too high for the material",
            "Chips packed around the tool or poor chip evacuation",
            "Spindle bearing wear (if it repeats on easy jobs)",
        ],
        "checks": [
            "Inspect the tool edge and replace it if worn",
            "Compare feed and speed with the job sheet",
            "Clear chips and check coolant reaches the cut",
            "Note spindle load on restart; repeat overloads need a bearing check",
        ],
        "safety": ["Lock out the spindle before touching the tool", "Wait for the spindle to stop fully"],
        "parts": ["Spare cutting tool"],
        "typical_minutes": "15-30",
    },
    "E-221": {
        "title": "Coolant low",
        "likely_causes": [
            "Coolant tank below minimum level",
            "Leak at a hose, fitting or the tank",
            "Coolant carried out on chips and parts faster than usual",
        ],
        "checks": [
            "Check the tank level and top up with the correct concentration",
            "Look for wet spots under the machine and at hose joints",
            "Clean the coolant filter or strainer",
        ],
        "safety": ["Wear gloves and eye protection when handling coolant", "Wipe up spills to prevent slips"],
        "parts": ["Coolant concentrate", "Hose clamp (if leaking)"],
        "typical_minutes": "10-20",
    },
    "E-310": {
        "title": "Door open",
        "likely_causes": [
            "Guard door not fully closed",
            "Door interlock switch misaligned or dirty",
            "Interlock switch or cable damaged",
        ],
        "checks": [
            "Close the door firmly and reset the alarm",
            "Clean and realign the interlock actuator",
            "If it repeats with the door closed, test the switch and cable",
        ],
        "safety": ["Never bypass the door interlock", "Do not reach into the machine while it can move"],
        "parts": ["Interlock switch (if faulty)"],
        "typical_minutes": "5-20",
    },
    "E-415": {
        "title": "Air pressure low",
        "likely_causes": [
            "Shop compressor pressure dropped",
            "Air hose disconnected, kinked or leaking",
            "Regulator set too low or filter blocked",
        ],
        "checks": [
            "Read the machine's air gauge and the shop supply pressure",
            "Listen for leaks along the hose and fittings",
            "Drain the water trap and check the filter and regulator",
        ],
        "safety": ["Release air pressure before opening fittings"],
        "parts": ["Air hose fitting", "Filter element"],
        "typical_minutes": "10-25",
    },
    "E-502": {
        "title": "Feed jam",
        "likely_causes": [
            "Part or blank stuck in the feeder",
            "Material out of tolerance or bent",
            "Feeder guide worn or misadjusted",
        ],
        "checks": [
            "Clear the jammed part with the feeder stopped",
            "Check the next blanks for bends or burrs",
            "Check the feeder guide width against the material",
        ],
        "safety": ["Stop and lock out the feeder before clearing the jam", "Use a tool, not fingers, near pinch points"],
        "parts": [],
        "typical_minutes": "5-15",
    },
    "E-618": {
        "title": "Hydraulic temperature high",
        "likely_causes": [
            "Oil cooler fins blocked with dust",
            "Hydraulic oil level low",
            "Cooler fan not running",
            "High ambient temperature or long continuous cycles",
        ],
        "checks": [
            "Let the unit cool, then check the oil level",
            "Clean the cooler fins and confirm the fan runs",
            "Check for leaks around the pump and hoses",
        ],
        "safety": ["Hydraulic oil and lines can be hot: let them cool", "Never loosen a pressurised hydraulic line"],
        "parts": ["Hydraulic oil", "Cooler fan (if not running)"],
        "typical_minutes": "20-45",
    },
}

_CODE_RE = re.compile(r"\b([A-Z]{1,3})-?(\d{2,4})\b")


def lookup(alarm_text: str | None) -> dict | None:
    """Returns the guide entry for an alarm text such as "E-221 COOLANT LOW", or None."""
    if not alarm_text:
        return None
    text = alarm_text.upper()
    m = _CODE_RE.search(text)
    if m:
        code = f"{m.group(1)}-{m.group(2)}"
        if code in ALARM_GUIDE:
            return {"code": code, **ALARM_GUIDE[code], "source": GUIDE_SOURCE}
    for code, entry in ALARM_GUIDE.items():
        if str(entry["title"]).upper() in text:
            return {"code": code, **entry, "source": GUIDE_SOURCE}
    return None
