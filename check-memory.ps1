$OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "       Process Memory Check Tool" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

function Show-ProcessMemory {
    param([string]$ProcessName)
    
    Write-Host "[$ProcessName Process]" -ForegroundColor Yellow
    Write-Host "----------------------------------------"
    
    $processes = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue
    if ($processes) {
        foreach ($p in $processes) {
            $workingMB = [math]::Round($p.WorkingSet64/1MB, 2)
            $pagedMB = [math]::Round($p.PagedMemorySize64/1MB, 2)
            Write-Host "  PID: $($p.Id)  WorkingSet: $workingMB MB  PagedMem: $pagedMB MB"
        }
    } else {
        Write-Host "  No $ProcessName process found" -ForegroundColor Gray
    }
    Write-Host ""
}

Show-ProcessMemory "node"
Show-ProcessMemory "cmd"
Show-ProcessMemory "powershell"
Show-ProcessMemory "codex"
Show-ProcessMemory "trae"

Write-Host "[Top 10 Memory Usage]" -ForegroundColor Yellow
Write-Host "----------------------------------------"
$top10 = Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 10
foreach ($p in $top10) {
    $workingMB = [math]::Round($p.WorkingSet64/1MB, 2)
    $pidStr = $p.Id.ToString().PadLeft(6)
    $nameStr = $p.ProcessName.PadRight(20)
    Write-Host "  PID: $pidStr  $nameStr  $workingMB MB"
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
