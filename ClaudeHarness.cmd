@echo off
rem ClaudeHarness from source: double-click to run (no install). Close this window to stop.
cd /d "%~dp0"
if not exist node_modules call npm.cmd ci
call npm.cmd run desktop:dev
pause
