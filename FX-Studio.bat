@echo off
chcp 65001 >nul
title FX Studio
cd /d "%~dp0"

echo.
echo   Starting FX Studio...
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [!] node.exe not found on PATH.
  echo       Install Node.js, or open a terminal that has it, then run again.
  echo.
  pause
  exit /b 1
)

node "scripts\fx-studio.mjs" --open

echo.
echo   FX Studio stopped.
pause
