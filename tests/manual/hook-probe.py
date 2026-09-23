import subprocess
import sys
import tempfile
import os

EV = tempfile.mkdtemp(prefix="hookdbg-")
script = r'''
import sys, os
EV = os.environ.get("LOOPLAB_SANDBOX_DIR") or os.path.dirname(os.path.abspath(__file__))
EV = os.path.realpath(EV)
_ALLOW_PREFIX = EV + os.sep
def _deny(msg):
    os.write(2, msg.encode())
    raise PermissionError(msg)
def _guard(event, args):
    if event == "open":
        path = args[0] if args else None
        if isinstance(path, str) and path:
            p = os.path.realpath(path)
            inside = p.startswith(_ALLOW_PREFIX)
            stdlib = p.startswith(os.path.realpath(sys.prefix) + os.sep)
            if not (inside or stdlib):
                _deny("LOOPLAB_SANDBOX: open denied")
sys.addaudithook(_guard)
try:
    open(r"D:\project\looplab\sealed\x.json")
except Exception as e:
    print("caught:", type(e).__name__)
try:
    open(os.path.join(EV, "allowed.txt"), "w").write("ok")
    print("inside write: fine")
except Exception as e:
    print("inside blocked?!", type(e).__name__)
'''
open(os.path.join(EV, "t.py"), "w").write(script)
p = subprocess.run([sys.executable, "-I", os.path.join(EV, "t.py")], capture_output=True,
                   env={"PATH": os.environ["PATH"], "SYSTEMROOT": "C:\\Windows", "LOOPLAB_SANDBOX_DIR": EV})
print("OUT:", p.stdout.decode())
print("ERR:", p.stderr.decode()[-300:])
