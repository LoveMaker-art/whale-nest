"""Visible text guard; the liveware runs independently of the voice plugin."""
import unicodedata


def has_body(text):
    return isinstance(text, str) and any(not c.isspace() and
        unicodedata.category(c)[0] != 'C' for c in text)
