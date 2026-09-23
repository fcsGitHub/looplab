"""复现失败范式：进程级故障注入（需要 spawn 子进程）——在沙箱中必然失败。

这是 3 次失败的典型写法：启动被测进程，然后 kill/信号 注入崩溃故障。
运行会抛出：PermissionError: LOOPLAB_SANDBOX: subprocess.Popen denied
"""
import subprocess
import sys


def inject_crash_fault(cmd):
    """启动 SUT 子进程，然后 kill 它来注入崩溃故障。"""
    proc = subprocess.Popen(cmd)          # <-- 沙箱在此拒绝
    proc.kill()
    return "crash-injected"


if __name__ == "__main__":
    try:
        print(inject_crash_fault([sys.executable, "-c", "import time; time.sleep(5)"]))
    except Exception as e:
        print("NAIVE HARNESS FAILED:", type(e).__name__, "->", e)
