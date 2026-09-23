"""End-to-end style test for the chat input box.

This test drives a small DOM-like harness that mimics a real ``<textarea>``
interaction: characters are typed into the input, keydown events are
dispatched, and the resulting side effects (message sent / newline inserted)
are observed.  It exercises the same ``handle_keydown`` handler that the unit
tests cover, but through a realistic event flow rather than by calling the
handler in isolation.

Because the sandbox has no browser, the harness reproduces the relevant DOM
semantics:

  * typing appends to the input value,
  * ``keydown`` is dispatched before the default action,
  * ``preventDefault()`` suppresses the default newline insertion,
  * ``isComposing`` is set while an IME composition is active.

Test names are prefixed with the acceptance-criteria id they verify.

Runnable with the Python standard library only:

    python -m unittest discover -s tests -p "test_*_e2e.py" -v
"""

from __future__ import annotations

import os
import sys
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from src.chat_input import KeyboardEvent, handle_keydown  # noqa: E402


class ChatInputHarness:
    """A minimal DOM-like chat input box.

    Models the subset of ``<textarea>`` behaviour needed to verify the Enter
    send shortcut end to end.
    """

    def __init__(self) -> None:
        self.value: str = ""
        self.sent_messages: list[str] = []
        self.is_composing: bool = False

    # -- user interaction ---------------------------------------------------
    def type_text(self, text: str) -> None:
        """Append typed characters to the input value."""
        self.value += text

    def press_enter(self, shift: bool = False) -> None:
        """Dispatch a keydown for the Enter key and apply the default action.

        The default action for Enter in a textarea is to insert a newline
        unless the handler calls ``preventDefault()``.
        """
        event = KeyboardEvent(
            key="Enter",
            shift_key=shift,
            is_composing=self.is_composing,
            value=self.value,
        )
        result = handle_keydown(event)

        if result.send:
            self.sent_messages.append(result.payload)
            self.value = ""  # sending clears the input box
        elif result.insert_newline:
            self.value += "\n"
        elif result.prevent_default:
            # Default newline insertion suppressed; nothing else happens.
            pass
        else:
            # No handler decision -> browser default inserts a newline.
            self.value += "\n"

    # -- IME composition ----------------------------------------------------
    def start_composition(self) -> None:
        self.is_composing = True

    def end_composition(self, committed_text: str) -> None:
        self.value += committed_text
        self.is_composing = False


class TestEnterSendE2E(unittest.TestCase):
    """End-to-end coverage of the real input-box interaction."""

    # ------------------------------------------------------------------ AC-1
    def test_ac1_typing_then_enter_sends_message(self):
        """AC-1: type text, press Enter -> message is sent and box cleared."""
        box = ChatInputHarness()
        box.type_text("hello world")
        box.press_enter()
        self.assertEqual(box.sent_messages, ["hello world"])
        self.assertEqual(box.value, "", "input box must be cleared after send")

    def test_ac1_multiple_messages_in_sequence(self):
        """AC-1: repeated type+Enter sends each message in order."""
        box = ChatInputHarness()
        for msg in ("first", "second", "third"):
            box.type_text(msg)
            box.press_enter()
        self.assertEqual(box.sent_messages, ["first", "second", "third"])
        self.assertEqual(box.value, "")

    # ------------------------------------------------------------------ AC-2
    def test_ac2_shift_enter_inserts_newline_without_sending(self):
        """AC-2: Shift+Enter inserts a newline and sends nothing."""
        box = ChatInputHarness()
        box.type_text("line1")
        box.press_enter(shift=True)
        box.type_text("line2")
        self.assertEqual(box.sent_messages, [], "Shift+Enter must not send")
        self.assertEqual(box.value, "line1\nline2")

    def test_ac2_shift_enter_then_enter_sends_multiline(self):
        """AC-2/AC-1: build a multiline message then send with plain Enter."""
        box = ChatInputHarness()
        box.type_text("line1")
        box.press_enter(shift=True)
        box.type_text("line2")
        box.press_enter()
        self.assertEqual(box.sent_messages, ["line1\nline2"])
        self.assertEqual(box.value, "")

    # ------------------------------------------------------------------ AC-3
    def test_ac3_enter_on_empty_box_does_not_send(self):
        """AC-3: pressing Enter on an empty box sends nothing."""
        box = ChatInputHarness()
        box.press_enter()
        self.assertEqual(box.sent_messages, [])
        self.assertEqual(box.value, "", "empty box stays empty")

    def test_ac3_enter_on_whitespace_only_box_does_not_send(self):
        """AC-3: whitespace-only content is not sent."""
        box = ChatInputHarness()
        box.type_text("   ")
        box.press_enter()
        self.assertEqual(box.sent_messages, [])
        self.assertEqual(box.value, "   ", "whitespace content is preserved")

    # ------------------------------------------------------------------ AC-4
    def test_ac4_enter_during_ime_composition_does_not_send(self):
        """AC-4: Enter while composing (IME) must not send."""
        box = ChatInputHarness()
        box.start_composition()
        box.type_text("ni hao")
        box.press_enter()
        self.assertEqual(box.sent_messages, [], "composing Enter must not send")
        self.assertEqual(box.value, "ni hao")

    def test_ac4_ime_commit_then_enter_sends(self):
        """AC-4/AC-1: after the IME commits, Enter sends the committed text."""
        box = ChatInputHarness()
        box.start_composition()
        box.type_text("ni hao")
        box.press_enter()  # ignored: still composing
        box.end_composition("你好")
        box.press_enter()  # now sends
        self.assertEqual(box.sent_messages, ["你好"])
        self.assertEqual(box.value, "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
