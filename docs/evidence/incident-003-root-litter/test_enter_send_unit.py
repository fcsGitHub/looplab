"""Unit tests for the chat input keydown handler.

Every test name is prefixed with the acceptance-criteria id it verifies so the
mapping between tests and t1 acceptance criteria is explicit:

  * AC-1  Enter (no Shift) with content  -> send
  * AC-2  Shift+Enter                    -> newline, no send
  * AC-3  empty / whitespace-only        -> no send
  * AC-4  isComposing == True            -> no send

Runnable with the Python standard library only:

    python -m unittest discover -s tests -p "test_*_unit.py" -v
"""

from __future__ import annotations

import os
import sys
import unittest

# Make ``src`` importable regardless of the invocation directory.
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from src.chat_input import KeyboardEvent, handle_keydown  # noqa: E402


class TestEnterSendUnit(unittest.TestCase):
    """Unit coverage for the keydown handler (t2 code location)."""

    # ------------------------------------------------------------------ AC-1
    def test_ac1_enter_with_content_triggers_send(self):
        """AC-1: plain Enter with non-empty content sends the message."""
        result = handle_keydown(KeyboardEvent(key="Enter", value="hello"))
        self.assertTrue(result.send, "Enter with content must send")
        self.assertEqual(result.payload, "hello")
        self.assertTrue(result.prevent_default)
        self.assertFalse(result.insert_newline)

    def test_ac1_enter_with_content_preserves_whitespace_payload(self):
        """AC-1: the sent payload is the raw value (not stripped)."""
        result = handle_keydown(KeyboardEvent(key="Enter", value="  hi  "))
        self.assertTrue(result.send)
        self.assertEqual(result.payload, "  hi  ")

    def test_ac1_enter_with_multiline_content_sends(self):
        """AC-1: content that already contains newlines still sends."""
        result = handle_keydown(KeyboardEvent(key="Enter", value="line1\nline2"))
        self.assertTrue(result.send)
        self.assertEqual(result.payload, "line1\nline2")

    # ------------------------------------------------------------------ AC-2
    def test_ac2_shift_enter_does_not_send(self):
        """AC-2: Shift+Enter must not send."""
        result = handle_keydown(
            KeyboardEvent(key="Enter", shift_key=True, value="hello")
        )
        self.assertFalse(result.send, "Shift+Enter must not send")
        self.assertIsNone(result.payload)
        self.assertTrue(result.insert_newline, "Shift+Enter inserts a newline")

    def test_ac2_shift_enter_with_empty_content_still_no_send(self):
        """AC-2: Shift+Enter never sends, even with empty content."""
        result = handle_keydown(
            KeyboardEvent(key="Enter", shift_key=True, value="")
        )
        self.assertFalse(result.send)
        self.assertTrue(result.insert_newline)

    # ------------------------------------------------------------------ AC-3
    def test_ac3_empty_content_does_not_send(self):
        """AC-3: Enter with empty content must not send."""
        result = handle_keydown(KeyboardEvent(key="Enter", value=""))
        self.assertFalse(result.send, "empty content must not send")
        self.assertIsNone(result.payload)

    def test_ac3_whitespace_only_content_does_not_send(self):
        """AC-3: Enter with whitespace-only content must not send."""
        for value in (" ", "   ", "\t", "\n", " \t\n "):
            with self.subTest(value=repr(value)):
                result = handle_keydown(KeyboardEvent(key="Enter", value=value))
                self.assertFalse(result.send, f"{value!r} must not send")

    def test_ac3_none_content_does_not_send(self):
        """AC-3: a missing value is treated as empty and must not send."""
        result = handle_keydown(KeyboardEvent(key="Enter", value=None))
        self.assertFalse(result.send)

    # ------------------------------------------------------------------ AC-4
    def test_ac4_is_composing_true_does_not_send(self):
        """AC-4: while composing (IME), Enter must not send."""
        result = handle_keydown(
            KeyboardEvent(key="Enter", is_composing=True, value="ni hao")
        )
        self.assertFalse(result.send, "isComposing=true must not send")
        self.assertIsNone(result.payload)

    def test_ac4_is_composing_true_overrides_shift_enter(self):
        """AC-4: composing takes precedence over the Shift+Enter branch."""
        result = handle_keydown(
            KeyboardEvent(key="Enter", shift_key=True, is_composing=True, value="x")
        )
        self.assertFalse(result.send)
        self.assertFalse(result.insert_newline)

    def test_ac4_is_composing_true_with_empty_content_does_not_send(self):
        """AC-4: composing with empty content must not send."""
        result = handle_keydown(
            KeyboardEvent(key="Enter", is_composing=True, value="")
        )
        self.assertFalse(result.send)

    # --------------------------------------------------------- non-Enter keys
    def test_non_enter_key_is_noop(self):
        """Guard: keys other than Enter never send."""
        for key in ("a", "Escape", "Tab", " "):
            with self.subTest(key=key):
                result = handle_keydown(KeyboardEvent(key=key, value="hello"))
                self.assertFalse(result.send)
                self.assertFalse(result.insert_newline)


if __name__ == "__main__":
    unittest.main(verbosity=2)
