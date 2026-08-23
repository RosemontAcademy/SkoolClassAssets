@echo off
chcp 65001 >nul
title FX Studio autostart OFF
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scriptsutostart.ps1" -Action off
pause
