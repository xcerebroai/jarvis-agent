@echo off
REM jarvis.cmd — branded shim for native Windows shells (cmd.exe / PowerShell).
REM Forwards every argument to the real `hermes` command, after switching the
REM console to UTF-8 so the JARVIS banner/box-art renders instead of mojibake.
REM
REM Resolution order (e2e-caught defect: this shim is installed NEXT TO
REM hermes.exe in venv\Scripts, and must work when invoked by absolute path
REM from a shell whose PATH does not contain that dir):
REM   1. %~dp0hermes.exe  — sibling exe (venv\Scripts layout)
REM   2. hermes on PATH
REM   3. %USERPROFILE%\.local\bin\hermes.cmd — the cross-shell wrapper
REM      install-jarvis.sh writes there (there is never a hermes.exe in
REM      .local\bin; the old fallback checked one and always missed).
setlocal
chcp 65001 >nul 2>&1
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
if exist "%~dp0hermes.exe" (
  "%~dp0hermes.exe" %*
  goto :done
)
where hermes >nul 2>&1
if %ERRORLEVEL%==0 (
  hermes %*
  goto :done
)
if exist "%USERPROFILE%\.local\bin\hermes.cmd" (
  call "%USERPROFILE%\.local\bin\hermes.cmd" %*
  goto :done
)
echo jarvis: could not find the 'hermes' runtime on PATH. 1>&2
echo         Reinstall with install-jarvis.sh, or add hermes to PATH. 1>&2
exit /b 127
:done
endlocal & exit /b %ERRORLEVEL%
