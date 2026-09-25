"""Unit tests for Enter-to-send, mapping 1:1 to ACCEPTANCE_CRITERIA.md AC-01..AC-12."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from chat_input import ChatInput, KeyEvent  # noqa: E402


class Recorder:
    def __init__(self):
        self.calls = []

    def __call__(self, value):
        self.calls.append(value)


def make(value="", disabled=False, composing=False):
    rec = Recorder()
    ci = ChatInput(on_send=rec, value=value, disabled=disabled, composing=composing)
    return ci, rec


class TestEnterSend(unittest.TestCase):
    def test_ac01_enter_sends(self):
        ci, rec = make("hello")
        action = ci.handle_key_down(KeyEvent("Enter"))
        self.assertEqual(action, "send")
        self.assertEqual(rec.calls, ["hello"])
        self.assertEqual(ci.value, "")

    def test_ac02_shift_enter_newline(self):
        ci, rec = make("hello")
        action = ci.handle_key_down(KeyEvent("Enter", shift=True))
        self.assertEqual(action, "newline")
        self.assertEqual(rec.calls, [])
        self.assertEqual(ci.value, "hello")

    def test_ac03_empty_no_send(self):
        ci, rec = make("")
        action = ci.handle_key_down(KeyEvent("Enter"))
        self.assertEqual(action, "none")
        self.assertEqual(rec.calls, [])
        self.assertEqual(ci.value, "")

    def test_ac04_spaces_no_send(self):
        ci, rec = make("   ")
        action = ci.handle_key_down(KeyEvent("Enter"))
        self.assertEqual(action, "none")
        self.assertEqual(rec.calls, [])

    def test_ac05_whitespace_chars_no_send(self):
        ci, rec = make("\n\t  ")
        action = ci.handle_key_down(KeyEvent("Enter"))
        self.assertEqual(action, "none")
        self.assertEqual(rec.calls, [])

    def test_ac06_trim_on_send(self):
        ci, rec = make("  hi  ")
        action = ci.handle_key_down(KeyEvent("Enter"))
        self.assertEqual(action, "send")
        self.assertEqual(rec.calls, ["hi"])

    def test_ac07_composing_no_send(self):
        ci, rec = make("hi", composing=True)
        action = ci.handle_key_down(KeyEvent("Enter"))
        self.assertEqual(action, "none")
        self.assertEqual(rec.calls, [])

    def test_ac08_disabled_no_send(self):
        ci, rec = make("hi", disabled=True)
        action = ci.handle_key_down(KeyEvent("Enter"))
        self.assertEqual(action, "none")
        self.assertEqual(rec.calls, [])

    def test_ac09_other_key_no_send(self):
        ci, rec = make("hi")
        action = ci.handle_key_down(KeyEvent("a"))
        self.assertEqual(action, "none")
        self.assertEqual(rec.calls, [])

    def test_ac10_long_text_sent_intact(self):
        long_text = "x" * 10000
        ci, rec = make(long_text)
        action = ci.handle_key_down(KeyEvent("Enter"))
        self.assertEqual(action, "send")
        self.assertEqual(len(rec.calls), 1)
        self.assertEqual(len(rec.calls[0]), 10000)

    def test_ac11_double_enter_sends_once(self):
        ci, rec = make("hi")
        a1 = ci.handle_key_down(KeyEvent("Enter"))
        a2 = ci.handle_key_down(KeyEvent("Enter"))
        self.assertEqual(a1, "send")
        self.assertEqual(a2, "none")
        self.assertEqual(rec.calls, ["hi"])

    def test_ac12_focus_retained_after_send(self):
        ci, rec = make("hi")
        before = ci.focus_calls
        ci.handle_key_down(KeyEvent("Enter"))
        self.assertGreater(ci.focus_calls, before)
        self.assertTrue(ci.focused)


if __name__ == "__main__":
    unittest.main(verbosity=2)
