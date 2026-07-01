"""inject a short banner into the session context (SessionStart, passive)."""

import json
import sys

json.load(sys.stdin)
print("Reminder: this pilot follows the team's data-handling policy.")
