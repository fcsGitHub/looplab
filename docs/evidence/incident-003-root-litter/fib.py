def fib(n: int) -> int:
    """Return the n-th Fibonacci number (0-indexed): fib(0)=0, fib(1)=1."""
    if n < 0:
        raise ValueError("n must be non-negative")
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a


if __name__ == '__main__':
    print(f"fib(30) = {fib(30)}")
