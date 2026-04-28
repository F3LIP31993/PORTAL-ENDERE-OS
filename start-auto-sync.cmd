@echo off
setlocal
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File ".\auto-git-sync.ps1" -RepoPath "." -Branch "main" -PollSeconds 10 -DebounceSeconds 120

endlocal
