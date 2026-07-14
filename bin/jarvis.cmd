@echo off
REM jarvis.cmd — branded shim for native Windows shells (cmd.exe / PowerShell).
REM Forwards every argument to the real `hermes` command, after switching the
REM console to UTF-8 so the JARVIS banner/box-art renders instead of mojibake.
setlocal
chcp 65001 >nul 2>&1
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
where hermes >nul 2>&1
if %ERRORLEVEL%==0 (
  hermes %*
) else if exist "%USERPROFILE%\.local\bin\hermes.exe" (
  "%USERPROFILE%\.local\bin\hermes.exe" %*
) else (
  echo jarvis: could not find the 'hermes' runtime on PATH. 1>&2
  echo         Reinstall with install-jarvis.sh, or add hermes to PATH. 1>&2
  exit /b 127
)
endlocal
