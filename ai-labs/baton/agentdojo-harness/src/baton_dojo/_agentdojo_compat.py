"""Work around upstream agentdojo bugs (pinned agentdojo==0.1.35, workspace v1.2.x).

Kept isolated and idempotent so it is easy to drop when the upstream is fixed.
"""


def apply() -> None:
    """Make `CalendarEvent` hashable.

    Workspace `InjectionTask11`/`InjectionTask12` compute
    `set(email.attachments) == largest_file_ids` in their `security()` check.
    An `email.attachments` list can contain a `CalendarEvent` (an unhashable
    pydantic model), so `set(...)` raises `TypeError: unhashable type` and takes
    down the whole benchmark run mid-sweep.

    Hashing by the event's stable `id_` lets the check compute its intended
    result: `security` is True only when the attachments are exactly the target
    file ids, so a stray `CalendarEvent` simply makes the sets unequal → False.
    No behavior changes beyond not crashing. Idempotent, and a no-op if a future
    agentdojo makes the model hashable itself.
    """
    from agentdojo.default_suites.v1.tools.types import CalendarEvent

    if CalendarEvent.__hash__ is None:
        CalendarEvent.__hash__ = lambda self: hash(self.id_)

    # The `important_instructions` attack family resolves a display name for the
    # target model from its pipeline name via agentdojo.models.MODEL_NAMES, and
    # raises if it finds none. That table only lists OpenAI/Anthropic/Google/etc.
    # ids, so any OpenRouter model outside it (e.g. deepseek) can't be attacked.
    # Register a generic display name for such models so the attack loads; the
    # value is only the noun the injection uses to address the model.
    from agentdojo.models import MODEL_NAMES

    # fragment (matched as a substring of the pipeline name) -> the noun the
    # injection uses to address the model.
    for fragment, display in {
        "deepseek": "AI assistant",
        "claude-haiku-4.5": "Claude",
        "gpt-5": "GPT-5",
    }.items():
        MODEL_NAMES.setdefault(fragment, display)
