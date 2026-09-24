@echo off
setlocal enabledelayedexpansion

:: ==============================================================================
:: VMM ENTERPRISE ON-PREMISE DATABASE & UPLOADS RESTORE SCRIPT
:: ==============================================================================

set SCRIPT_DIR=%~dp0
set BACKEND_DIR=%SCRIPT_DIR%..
set PROJECT_DIR=%BACKEND_DIR%\..

if exist "%PROJECT_DIR%\uploads" (
    set UPLOADS_DIR=%PROJECT_DIR%\uploads
) else (
    set UPLOADS_DIR=%BACKEND_DIR%\uploads
)

if not defined BACKUP_DIR (
    if exist "F:\" (
        set BACKUP_DIR=F:\vmm_backups
    ) else (
        set BACKUP_DIR=%PROJECT_DIR%\backups
    )
)
set DB_NAME=vmm_enterprise_db
set DB_HOST=127.0.0.1:27017

echo ========================================================
echo        VMM ENTERPRISE RESTORE UTILITY
echo ========================================================

:: --- STEP 1: LOCATE MONGORESTORE ---
set MONGORESTORE_EXE=
where mongorestore >nul 2>&1
if %ERRORLEVEL% equ 0 (
    set MONGORESTORE_EXE=mongorestore
) else (
    for /d %%D in ("C:\Program Files\MongoDB\Tools\*") do (
        if exist "%%D\bin\mongorestore.exe" set MONGORESTORE_EXE="%%D\bin\mongorestore.exe"
    )
    if not defined MONGORESTORE_EXE (
        for /d %%D in ("C:\Program Files\MongoDB\Server\*") do (
            if exist "%%D\bin\mongorestore.exe" set MONGORESTORE_EXE="%%D\bin\mongorestore.exe"
        )
    )
)

if not defined MONGORESTORE_EXE (
    echo [ERROR] mongorestore.exe not found!
    echo Please install MongoDB Database Tools from mongodb.com/try/download/database-tools
    pause
    exit /b 1
)

:: --- STEP 2: FIND LATEST DB BACKUP FILE ---
set LATEST_DB_BACKUP=
for /f "delims=" %%F in ('dir /b /o:-d "%BACKUP_DIR%\db_%DB_NAME%_*.gz" 2^>nul') do (
    set LATEST_DB_BACKUP=%BACKUP_DIR%\%%F
    goto FOUND_DB
)

:FOUND_DB
if not defined LATEST_DB_BACKUP (
    echo [ERROR] No database backup files found in "%BACKUP_DIR%"!
    pause
    exit /b 1
)

echo Found latest database backup: %LATEST_DB_BACKUP%
echo.
set /p CONFIRM="WARNING: Restoring will overwrite existing data in %DB_NAME%. Proceed? (Y/N): "
if /i not "%CONFIRM%"=="Y" (
    echo Restore cancelled by user.
    pause
    exit /b 0
)

echo Restoring MongoDB database "%DB_NAME%"...
%MONGORESTORE_EXE% --host=%DB_HOST% --db=%DB_NAME% --drop --gzip --archive="%LATEST_DB_BACKUP%"
if %ERRORLEVEL% equ 0 (
    echo [SUCCESS] MongoDB database restored successfully!
) else (
    echo [ERROR] Database restore failed with code %ERRORLEVEL%.
)

:: --- STEP 3: FIND AND RESTORE LATEST UPLOADS ---
set LATEST_UPLOADS_BACKUP=
for /f "delims=" %%F in ('dir /b /o:-d "%BACKUP_DIR%\uploads_*.tar.gz" 2^>nul') do (
    set LATEST_UPLOADS_BACKUP=%BACKUP_DIR%\%%F
    goto FOUND_UPLOADS
)

:FOUND_UPLOADS
if defined LATEST_UPLOADS_BACKUP (
    echo.
    echo Found latest uploads archive: %LATEST_UPLOADS_BACKUP%
    if not exist "%UPLOADS_DIR%" mkdir "%UPLOADS_DIR%"
    echo Extracting files to "%UPLOADS_DIR%"...
    tar -xzf "%LATEST_UPLOADS_BACKUP%" -C "%UPLOADS_DIR%"
    if %ERRORLEVEL% equ 0 (
        echo [SUCCESS] Uploaded attachments restored successfully!
    )
)

echo.
echo ========================================================
echo Restore procedure finished.
echo ========================================================
pause
