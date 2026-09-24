"""Factorial computation using an iterative approach."""


def factorial(n: int) -> int:
    """Return n! computed iteratively.

    Raises ValueError if n is negative.
    """
    if n < 0:
        raise ValueError("factorial() not defined for negative values")
    result = 1
    for i in range(2, n + 1):
        result *= i
    return result


if __name__ == '__main__':
    print(factorial(7))
