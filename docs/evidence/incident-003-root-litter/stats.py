"""Generate random numbers and compute basic statistics."""

import random
import statistics


def main():
    random.seed(42)
    nums = [random.random() for _ in range(100)]

    mean = statistics.mean(nums)
    var = statistics.pvariance(nums)

    print(f"n={len(nums)} mean={mean:.6f} var={var:.6f}")


if __name__ == '__main__':
    main()
