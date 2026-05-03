@echo off
setlocal

set "DPAGENT_ROOT=D:\work\MiniMaxAgentNodeJs"
set "DPAGENT_ENTRY=%DPAGENT_ROOT%\dist\cli\minimax-agent.js"
set "DPAGENT_SRC=%DPAGENT_ROOT%\src\cli\minimax-agent.ts"
set "DPAGENT_TSX=%DPAGENT_ROOT%\node_modules\tsx\dist\cli.mjs"

pushd "%DPAGENT_ROOT%" >nul

if exist "%DPAGENT_SRC%" if exist "%DPAGENT_TSX%" (
  node "%DPAGENT_TSX%" "%DPAGENT_SRC%" %*
) else (
  if not exist "%DPAGENT_ENTRY%" (
    echo Missing DPAgent dev source or CLI entry under %DPAGENT_ROOT% 1>&2
    popd >nul
    exit /b 1
  )
  node "%DPAGENT_ENTRY%" %*
)

set "EXIT_CODE=%ERRORLEVEL%"
popd >nul
exit /b %EXIT_CODE%
