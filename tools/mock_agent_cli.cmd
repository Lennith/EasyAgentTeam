@echo off
setlocal
node "%~dp0mock_agent_cli.mjs" %*
exit /b %errorlevel%
