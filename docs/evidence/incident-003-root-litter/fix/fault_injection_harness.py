"""进程内故障注入测试环境（沙箱安全：不使用 subprocess / os.system / multiprocessing）。

设计目标：在不 spawn 子进程的前提下，对被测系统（SUT）注入常见故障并观测行为：
  - crash     : 依赖抛异常
  - timeout   : 依赖阻塞超过阈值（用线程 join(timeout) 判定，不杀进程）
  - corrupt   : 依赖返回值被篡改
  - flaky     : 依赖前 N 次失败、之后成功（用于重试逻辑测试）

所有注入结果以结构化 dict 返回，绝不因沙箱策略以 unknown 逃逸。
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List


@dataclass
class InjectionResult:
    fault: str
    status: str                 # ok | error | timeout | sandbox_denied
    value: Any = None
    error: str | None = None
    detail: Dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> Dict[str, Any]:
        return {"fault": self.fault, "status": self.status,
                "value": self.value, "error": self.error, "detail": self.detail}


class FaultInjectionHarness:
    def __init__(self) -> None:
        self.results: List[InjectionResult] = []

    # ---------- 通用执行包装：显式捕获沙箱拒绝，避免 unknown ----------
    def _safe(self, fault: str, fn: Callable[[], Any]) -> InjectionResult:
        try:
            return InjectionResult(fault, "ok", value=fn())
        except PermissionError as e:
            # 沙箱策略拒绝：显式归类，不再以 unknown 失败
            return InjectionResult(fault, "sandbox_denied", error=str(e))
        except Exception as e:  # noqa: BLE001
            return InjectionResult(fault, "error", error=f"{type(e).__name__}: {e}")

    # ---------- 故障注入器 ----------
    def inject_crash(self, sut: Callable[[], Any], dep_name: str = "dep") -> InjectionResult:
        """崩溃注入：让依赖抛异常。"""
        def boom(*_a, **_k):
            raise RuntimeError(f"injected-crash:{dep_name}")
        return self._safe("crash", lambda: sut(boom))

    def inject_timeout(self, sut: Callable[[], Any], timeout_s: float) -> InjectionResult:
        """超时注入：线程内运行，超时即判定（不杀进程）。"""
        box: Dict[str, Any] = {}

        def target():
            try:
                box["value"] = sut()
            except Exception as e:  # noqa: BLE001
                box["error"] = f"{type(e).__name__}: {e}"

        t = threading.Thread(target=target, daemon=True)
        t.start()
        t.join(timeout_s)
        if t.is_alive():
            return InjectionResult("timeout", "timeout", detail={"after_s": timeout_s})
        if "error" in box:
            return InjectionResult("timeout", "error", error=box["error"])
        return InjectionResult("timeout", "ok", value=box.get("value"))

    def inject_corrupt(self, sut: Callable[[Any], Any], corruptor: Callable[[Any], Any],
                       arg: Any) -> InjectionResult:
        """数据损坏注入：篡改依赖返回值。"""
        def wrapped(*_a, **_k):
            return corruptor(arg)
        return self._safe("corrupt", lambda: sut(wrapped))

    def inject_flaky(self, sut: Callable[[Any], Any], fail_times: int) -> InjectionResult:
        """间歇故障注入：前 fail_times 次失败，之后成功（测试重试）。"""
        state = {"n": 0}

        def flaky(*_a, **_k):
            state["n"] += 1
            if state["n"] <= fail_times:
                raise RuntimeError(f"flaky-fail#{state['n']}")
            return f"ok-after-{state['n']}"

        return self._safe("flaky", lambda: sut(flaky))

    def run_all(self, sut_factory: Callable[[], Callable[[Callable], Any]]) -> List[Dict[str, Any]]:
        out = []
        out.append(self.inject_crash(sut_factory()).as_dict())
        out.append(self.inject_timeout(sut_factory(), 0.2).as_dict())
        out.append(self.inject_corrupt(sut_factory(), lambda v: v + 999, 5).as_dict())
        out.append(self.inject_flaky(sut_factory(), 2).as_dict())
        self.results = out
        return out


# ---------------- 示例 SUT ----------------
def make_sut() -> Callable[[Callable], Any]:
    """返回一个接受依赖 dep 的 SUT。"""
    def sut(dep):
        return dep(5) + 1
    return sut


if __name__ == "__main__":
    import json
    h = FaultInjectionHarness()
    print(json.dumps(h.run_all(make_sut), indent=2, ensure_ascii=False))
