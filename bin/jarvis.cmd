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
REM
REM `jarvis update` is intercepted before any of that — see below.
setlocal
chcp 65001 >nul 2>&1
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"

REM --- `jarvis update` -> the overlay-aware updater (finding #9) -------------
REM Parity with the bash shim (bin/jarvis). This file used to be a pure
REM passthrough, so `jarvis update` from PowerShell/cmd ran upstream's
REM `hermes update` — a git pull over the branded tree — and left the install
REM de-branded until the next apply. Git Bash users were protected; native
REM Windows shells were not. update-jarvis.sh does the conflict-free
REM revert -> update -> re-apply cycle instead.
REM
REM Falls through to the plain passthrough when no overlay checkout or no bash
REM can be found, so this never makes `jarvis update` worse than it was.
REM update-jarvis.sh sets JARVIS_NO_UPDATE_WRAP=1 on its own hermes/jarvis call,
REM which is what stops this from recursing back into itself.
if defined JARVIS_NO_UPDATE_WRAP goto :passthrough
if /I not "%~1"=="update" goto :passthrough

REM Same search order as bin/jarvis.
set "JOVL="
call :find_overlay "%JARVIS_OVERLAY_DIR%"
if not defined JOVL call :find_overlay "%LOCALAPPDATA%\hermes\jarvis-agent"
if not defined JOVL call :find_overlay "%USERPROFILE%\.hermes\jarvis-agent"
if not defined JOVL call :find_overlay "%USERPROFILE%\jarvis\jarvis-agent"
if not defined JOVL goto :passthrough

REM update-jarvis.sh is bash; native Windows shells have no bash of their own.
set "JBASH="
if exist "%ProgramFiles%\Git\bin\bash.exe" set "JBASH=%ProgramFiles%\Git\bin\bash.exe"
if not defined JBASH if exist "%ProgramFiles(x86)%\Git\bin\bash.exe" set "JBASH=%ProgramFiles(x86)%\Git\bin\bash.exe"
if not defined JBASH if exist "%LOCALAPPDATA%\Programs\Git\bin\bash.exe" set "JBASH=%LOCALAPPDATA%\Programs\Git\bin\bash.exe"
if not defined JBASH for /f "delims=" %%B in ('where bash 2^>nul') do if not defined JBASH set "JBASH=%%B"
if not defined JBASH goto :passthrough

REM Which Hermes tree does the update act on? Prefer the ACTIVE install
REM (%HERMES_HOME%\hermes-agent, default %LOCALAPPDATA%\hermes\hermes-agent):
REM that is the tree `hermes update` updates and the desktop rebuilds from.
REM Fall back to the overlay SIBLING, which is the same path on a customer
REM install (overlay at %LOCALAPPDATA%\hermes\jarvis-agent) so this is a
REM no-op there. They diverge only on a dev layout, where the sibling can be
REM a stale scratch clone and every update would miss the real install.
REM Only set HERMES_SRC when the caller has not already chosen one.
REM Forward slashes: bash treats a backslash as an escape, so a Windows-style
REM path breaks update-jarvis.sh's `cd "$SRC"`.
set "JHOME=%HERMES_HOME%"
if not defined JHOME set "JHOME=%LOCALAPPDATA%\hermes"
set "JSRC="
if exist "%JHOME%\hermes-agent\" set "JSRC=%JHOME%\hermes-agent"
if not defined JSRC for %%I in ("%JOVL%") do if exist "%%~dpIhermes-agent\" set "JSRC=%%~dpIhermes-agent"
if not defined HERMES_SRC if defined JSRC set "HERMES_SRC=%JSRC:\=/%"

REM Drop the `update` verb and forward the remaining args. update-jarvis.sh
REM takes the source tree as $1 (empty here — HERMES_SRC above wins) and passes
REM "${@:2}" through to the underlying update, so the "" placeholder matters.
set "JARGS="
shift
:collect_args
if "%~1"=="" goto :run_updater
set "JARGS=%JARGS% %1"
shift
goto :collect_args

:run_updater
set "JUPDATER=%JOVL:\=/%/update-jarvis.sh"
"%JBASH%" "%JUPDATER%" "" %JARGS%
goto :done

:passthrough
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

REM --- subroutines (unreachable by fall-through; :done exits above) ----------
REM Accept a candidate overlay dir only if it actually holds update-jarvis.sh.
:find_overlay
if "%~1"=="" goto :eof
if exist "%~1\update-jarvis.sh" set "JOVL=%~1"
goto :eof
