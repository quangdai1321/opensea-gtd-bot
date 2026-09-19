@echo off
REM Wrapper cho Windows. Chay: run.bat check   hoac  run.bat all
cd /d "%~dp0"
if not exist node_modules ( call npm install )
if "%1"=="" goto check
if "%1"=="setup" ( node setup-wallets.js %2 & goto end )
if "%1"=="encrypt" ( node encrypt-keys.js & goto end )
if "%1"=="inspect" ( node inspect.js & goto end )
if "%1"=="check" goto check
if "%1"=="all" ( node run-all.js & goto end )
if "%1"=="reset" ( node run-all.js --reset & goto end )
echo Dung: run.bat [setup N^|encrypt^|inspect^|check^|all^|reset]
goto end
:check
node run-all.js --check
:end
