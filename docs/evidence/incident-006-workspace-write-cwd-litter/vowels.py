def count_vowels(s: str) -> int:
    """Return the number of vowels (aeiou, case-insensitive) in s."""
    vowels = "aeiouAEIOU"
    return sum(1 for ch in s if ch in vowels)


if __name__ == '__main__':
    examples = [
        'hello',
        'AEIOU',
        '',
        'xyz',
        'Programming Is Fun',
    ]
    for text in examples:
        print(count_vowels(text))
