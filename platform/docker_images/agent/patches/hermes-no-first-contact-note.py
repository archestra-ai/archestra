"""Drop Hermes's first-contact onboarding note.

Every Archestra runtime starts with an empty HERMES_HOME, so Hermes treats each
run's first message as the install's first message ever and attaches a note
asking the model to introduce itself and mention /help. That introduction would
land in the Agent's answer, and no config key turns the plain note off. The
build fails when the anchor moves.
"""

import importlib.util
import sys
from pathlib import Path

ANCHOR = (
    "    if not session_history_empty or install_has_prior_sessions or onboarding_run_active:\n"
    "        return None\n"
)
PATCH = (
    "    # Archestra image patch: see docker_images/agent/patches/hermes-no-first-contact-note.py\n"
    "    return None\n"
)

# Locate without importing the agent package.
onboarding = Path(importlib.util.find_spec("agent").origin).with_name("onboarding.py")
source = onboarding.read_text()
if source.count(ANCHOR) != 1 or "def first_contact_turn_note(" not in source:
    sys.exit(f"Hermes first-contact onboarding changed; review {Path(__file__).name}")
onboarding.write_text(source.replace(ANCHOR, PATCH))
