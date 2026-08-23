@echo off
chcp 65001 >nul
title FX Studio autostart ON
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scriptsutostart.ps1" -Action on
pause
