"""Random-number statistics script.

Generates 100 uniform random numbers in [0, 1) with a fixed seed so the
results are reproducible, then reports count, mean and (population) variance.
"""

import random


def main():
    # Fix the seed so the generated sequence is reproducible across runs.
    random.seed(42)

    # Generate 100 random floats in the interval [0, 1).
    nums = [random.uniform(0, 1) for _ in range(100)]

    # Arithmetic mean of the sample.
    mean = sum(nums) / len(nums)

    # Population variance: divide by N (len(nums)), NOT by N-1.
    # This is the variance of the whole generated set, not an unbiased
    # sample-variance estimate.
    variance = sum((x - mean) ** 2 for x in nums) / len(nums)

    print(f"count={len(nums)}")
    print(f"mean={mean:.6f}")
    print(f"variance={variance:.6f}")


if __name__ == '__main__':
    main()
