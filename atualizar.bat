@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Atualizando o Jarvis...
git pull
if errorlevel 1 (
  echo.
  echo Nao foi possivel atualizar. Veja a mensagem acima.
  pause
  exit /b 1
)
call npm install --no-audit --no-fund
echo.
echo Pronto. Abrindo o Jarvis...
call npm start
