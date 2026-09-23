"""Utility module providing vowel counting."""

VOWELS = "aeiouAEIOU"


def count_vowels(s: str) -> int:
    """Count the number of vowel letters in ``s``.

    Vowels are ``a``, ``e``, ``i``, ``o``, ``u`` and their uppercase
    counterparts, so the count is case-insensitive.

    Args:
        s: The string to inspect.

    Returns:
        The number of vowel characters contained in ``s``.

    Raises:
        TypeError: If ``s`` is not a string.
    """
    if not isinstance(s, str):
        raise TypeError(f"expected str, got {type(s).__name__}")
    return sum(1 for ch in s if ch in VOWELS)


if __name__ == "__main__":
    print(count_vowels("Hello World"))
