@echo off
rem LoopLabStack scheduled-task wrapper (see scripts/dev-stack.mjs)
rem Register (per-user, no admin): schtasks /Create /TN LoopLabStack /TR "D:\project\looplab\scripts\stack-task.cmd" /SC MINUTE /MO 3 /F
rem Remove: schtasks /Delete /TN LoopLabStack /F
cd /d "%~dp0.."
"C:\Program Files\nodejs\node.exe" scripts\dev-stack.mjs
