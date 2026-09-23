param()
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*agent-worker*" } |
  ForEach-Object { Write-Output $_.ProcessId }
