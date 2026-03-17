Get-Process | Where-Object { $_.MainWindowTitle -like "*SimSig*" -or $_.ProcessName -like "*sim*" } |
    Select-Object ProcessName, Id, MainWindowTitle |
    Format-Table -AutoSize
