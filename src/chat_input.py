"""Reference implementation of the chat input keydown handler.

This module models the behaviour that the acceptance criteria (t1) require for
the chat input box:

  * AC-1  Enter (without Shift) with non-empty content triggers send.
  * AC-2  Shift+Enter inserts a newline and does NOT send.
  * AC-3  Empty / whitespace-only content does NOT send.
  * AC-4  While an IME composition is in progress (``isComposing`` true) the
          keydown is ignored and does NOT send.

The handler is intentionally framework agnostic: it consumes a plain
``KeyboardEvent``-like object and returns a ``KeydownResult`` describing what
the UI should do.  This keeps the logic unit-testable without a browser while
still being faithful to the DOM ``keydown`` event contract.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class KeyboardEvent:
    """Minimal stand-in for a DOM ``KeyboardEvent``.

    Attributes
    ----------
    key:
        Value of ``event.key`` (e.g. ``"Enter"``, ``"a"``).
    shift_key:
        Value of ``event.shiftKey``.
    is_composing:
        Value of ``event.isComposing`` (true while an IME composition is
        active).
    value:
        Current text content of the input box.
    """

    key: str
    shift_key: bool = False
    is_composing: bool = False
    value: str = ""


@dataclass
class KeydownResult:
    """Outcome of handling a keydown event.

    Attributes
    ----------
    send:
        ``True`` when the handler decided the message should be sent.
    prevent_default:
        ``True`` when the browser default action must be suppressed.
    insert_newline:
        ``True`` when a newline should be inserted into the input box.
    payload:
        The message that would be sent (``None`` when ``send`` is false).
    """

    send: bool = False
    prevent_default: bool = False
    insert_newline: bool = False
    payload: Optional[str] = None
    notes: list = field(default_factory=list)


def handle_keydown(event: KeyboardEvent) -> KeydownResult:
    """Handle a keydown event for the chat input box.

    Implements AC-1..AC-4.  The order of the guards matters:

    1. IME composition (AC-4) short-circuits everything.
    2. Only the ``Enter`` key is relevant; any other key is a no-op.
    3. ``Shift+Enter`` inserts a newline (AC-2).
    4. Empty / whitespace-only content is not sent (AC-3).
    5. Otherwise the message is sent (AC-1).
    """

    # AC-4: never send while an IME composition is in progress.
    if event.is_composing:
        return KeydownResult(notes=["ac4:is_composing"])

    # Only Enter participates in the send shortcut.
    if event.key != "Enter":
        return KeydownResult(notes=["non-enter-key"])

    # AC-2: Shift+Enter inserts a newline instead of sending.
    if event.shift_key:
        return KeydownResult(
            insert_newline=True,
            prevent_default=False,
            notes=["ac2:shift_enter"],
        )

    # AC-3: empty / whitespace-only content must not be sent.
    if event.value is None or event.value.strip() == "":
        return KeydownResult(
            prevent_default=True,
            notes=["ac3:empty_content"],
        )

    # AC-1: plain Enter with content sends the message.
    return KeydownResult(
        send=True,
        prevent_default=True,
        payload=event.value,
        notes=["ac1:enter_send"],
    )
