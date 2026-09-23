"""
independent_verify.py — 沙箱内可行的「逐位比对与独立复核」实现

背景（诊断结论）：
  原任务要求「独立复核」，常见实现是 fork 子进程 / subprocess / 读外部参考文件。
  但本沙箱（LOOPLAB_SANDBOX）明确拒绝：
    - subprocess.Popen / os.system / os.popen  -> PermissionError
    - 读取工作区之外的任何文件（参考数据、taskpack）-> PermissionError
    - 系统临时目录（%TEMP%, C:\WINDOWS\Temp, D:\tmp ...）-> PermissionError
  这些 PermissionError 未被上层分类，表现为 error="unknown"，导致同一策略重试 3 次全部失败。

修复策略：把「独立」从「跨进程/跨文件」降级为「跨实现/跨命名空间」：
  1. 用两条**算法上独立**的路径计算同一目标（例如 π 的 Machin 公式 vs 蒙特卡洛/级数）。
  2. 用 `exec` 在**全新命名空间**中重算（不复用被测模块的全局状态）。
  3. 逐位（digit-by-digit）比对，报告首个不一致位置。
  4. 所有中间产物只写工作区内（tempfile 已自动落到 cwd）。
  5. 不依赖 subprocess / 外部文件。

本文件可独立运行：python independent_verify.py
"""
import json
import sys
from decimal import Decimal, getcontext


# ---------- 实现 A：Machin 公式（arctan 级数），高精度 ----------
def pi_machin(digits: int) -> str:
    getcontext().prec = digits + 20
    # pi/4 = 4*arctan(1/5) - arctan(1/239)
    def arctan_inv(x: int) -> Decimal:
        x = Decimal(1) / Decimal(x)
        total = Decimal(0)
        term = x
        n = 0
        sign = 1
        x2 = x * x
        while True:
            add = term / (2 * n + 1)
            if add == 0:
                break
            total += sign * add
            term *= x2
            sign = -sign
            n += 1
        return total

    pi = 4 * (4 * arctan_inv(5) - arctan_inv(239))
    return str(+pi)  # 应用上下文精度


# ---------- 实现 B：Bailey–Borwein–Plouffe (BBP) 级数 ----------
def pi_bbp(digits: int) -> str:
    getcontext().prec = digits + 20
    total = Decimal(0)
    k = 0
    while True:
        d = Decimal(16) ** k
        term = (Decimal(4) / (8 * k + 1)
                - Decimal(2) / (8 * k + 4)
                - Decimal(1) / (8 * k + 5)
                - Decimal(1) / (8 * k + 6)) / d
        if term == 0:
            break
        total += term
        k += 1
        if k > 200:
            break
    return str(+total)


# ---------- 独立复核：在全新命名空间中重算（不复用本模块状态） ----------
def independent_recompute(digits: int) -> str:
    """用 exec 在全新命名空间里、以字符串源码方式重算 π（Machin），
    确保不共享任何被测模块的全局变量。"""
    src = '''
from decimal import Decimal, getcontext
getcontext().prec = %d + 20
def _at(x):
    x = Decimal(1)/Decimal(x); t = x; s = Decimal(0); n = 0; sg = 1; x2 = x*x
    while True:
        a = t/(2*n+1)
        if a == 0: break
        s += sg*a; t *= x2; sg = -sg; n += 1
    return s
_pi = 4*(4*_at(5) - _at(239))
RESULT = str(+_pi)
''' % digits
    ns = {}
    exec(src, ns)
    return ns["RESULT"]


# ---------- 逐位比对 ----------
def digit_compare(a: str, b: str):
    """返回 (equal, first_diff_index, detail)。逐字符（逐位）比对。"""
    n = min(len(a), len(b))
    for i in range(n):
        if a[i] != b[i]:
            return False, i, f"pos {i}: {a[i]!r} != {b[i]!r}"
    if len(a) != len(b):
        return False, n, f"length differs: {len(a)} vs {len(b)}"
    return True, -1, "all digits equal"


def main():
    digits = 60
    a = pi_machin(digits)
    b = pi_bbp(digits)
    c = independent_recompute(digits)

    eq_ab, idx_ab, det_ab = digit_compare(a, b)
    eq_ac, idx_ac, det_ac = digit_compare(a, c)

    report = {
        "digits_requested": digits,
        "impl_A_machin": a,
        "impl_B_bbp": b,
        "impl_C_independent_ns": c,
        "compare_A_vs_B": {"equal": eq_ab, "first_diff": idx_ab, "detail": det_ab},
        "compare_A_vs_C": {"equal": eq_ac, "first_diff": idx_ac, "detail": det_ac},
        "sandbox_primitives_used": ["decimal", "exec(fresh ns)", "workspace files only"],
        "sandbox_primitives_avoided": ["subprocess", "os.system", "multiprocessing", "external files", "system temp"],
    }
    with open("independent_verify_result.json", "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0 if (eq_ab and eq_ac) else 1


if __name__ == "__main__":
    sys.exit(main())
