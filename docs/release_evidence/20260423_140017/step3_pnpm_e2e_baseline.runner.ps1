Set-Location 'C:\Users\spiri\Documents\GitHub\EasyAgentTeam'
pnpm e2e:baseline *> 'C:\Users\spiri\Documents\GitHub\EasyAgentTeam\docs\release_evidence\20260423_140017\step3_pnpm_e2e_baseline.log'
$code=$LASTEXITCODE
Set-Content -Path 'C:\Users\spiri\Documents\GitHub\EasyAgentTeam\docs\release_evidence\20260423_140017\step3_pnpm_e2e_baseline.exitcode.txt' -Value $code -Encoding UTF8
Set-Content -Path 'C:\Users\spiri\Documents\GitHub\EasyAgentTeam\docs\release_evidence\20260423_140017\step3_pnpm_e2e_baseline.finished_at.txt' -Value (Get-Date -Format o) -Encoding UTF8
exit $code
