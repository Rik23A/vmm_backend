@echo off
setlocal enabledelayedexpansion

:: ==============================================================================
:: VMM ENTERPRISE ON-PREMISE AUTOMATED BACKUP SCRIPT
:: Backs up:
::   1. Local MongoDB Database (vmm_enterprise_db)
::   2. Uploaded Documents (GST, PAN, Cheques, etc. in uploads)
::   3. Keeps last 30 days of backups (auto-purges older files)
:: ==============================================================================

:: --- CONFIGURATION ---
set SCRIPT_DIR=%~dp0
set BACKEND_DIR=%SCRIPT_DIR%..
set PROJECT_DIR=%BACKEND_DIR%\..

:: Auto-detect uploads directory (sibling of backend or inside backend)
if exist "%PROJECT_DIR%\uploads" (
    set UPLOADS_DIR=%PROJECT_DIR%\uploads
) else (
    set UPLOADS_DIR=%BACKEND_DIR%\uploads
)

:: Default backup location: Use dedicated Backup (F:) drive if present, otherwise project folder
if not defined BACKUP_DIR (
    if exist "F:\" (
        set BACKUP_DIR=F:\vmm_backups
    ) else (
        set BACKUP_DIR=%PROJECT_DIR%\backups
    )
)
set DB_NAME=vmm_enterprise_db
set DB_HOST=127.0.0.1:27017
set RETENTION_DAYS=30
set LOG_FILE=%BACKUP_DIR%\backup.log

:: Create backup directory if not exists
if not exist "%BACKUP_DIR%" mkdir "%BACKUP_DIR%"

:: Timestamp generation (YYYY-MM-DD_HH-MM-SS)
for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value 2^>nul') do set DT=%%I
if defined DT (
    set TIMESTAMP=%DT:~0,4%-%DT:~4,2%-%DT:~6,2%_%DT:~8,2%-%DT:~10,2%-%DT:~12,2%
) else (
    set TIMESTAMP=%DATE:~10,4%-%DATE:~4,2%-%DATE:~7,2%_%TIME:~0,2%-%TIME:~3,2%-%TIME:~6,2%
    set TIMESTAMP=%TIMESTAMP: =0%
)

echo ======================================================== >> "%LOG_FILE%"
echo [%TIMESTAMP%] Starting VMM Enterprise Backup... >> "%LOG_FILE%"
echo [%TIMESTAMP%] Starting VMM Enterprise Backup...

:: --- STEP 1: LOCATE MONGODUMP ---
set MONGODUMP_EXE=
where mongodump >nul 2>&1
if %ERRORLEVEL% equ 0 (
    set MONGODUMP_EXE=mongodump
) else (
    for /d %%D in ("C:\Program Files\MongoDB\Tools\*") do (
        if exist "%%D\bin\mongodump.exe" set MONGODUMP_EXE="%%D\bin\mongodump.exe"
    )
    if not defined MONGODUMP_EXE (
        for /d %%D in ("C:\Program Files\MongoDB\Server\*") do (
            if exist "%%D\bin\mongodump.exe" set MONGODUMP_EXE="%%D\bin\mongodump.exe"
        )
    )
)

if not defined MONGODUMP_EXE (
    echo [ERROR] mongodump.exe not found! >> "%LOG_FILE%"
    echo [ERROR] Please install MongoDB Database Tools from mongodb.com/try/download/database-tools >> "%LOG_FILE%"
    echo [ERROR] mongodump.exe not found. Database backup skipped.
    goto BACKUP_UPLOADS
)

:: --- STEP 2: DUMP MONGODB DATABASE ---
set DB_BACKUP_FILE=%BACKUP_DIR%\db_%DB_NAME%_%TIMESTAMP%.gz
echo [%TIMESTAMP%] Backing up MongoDB database "%DB_NAME%" to %DB_BACKUP_FILE%... >> "%LOG_FILE%"
echo Backing up MongoDB database "%DB_NAME%"...

%MONGODUMP_EXE% --host=%DB_HOST% --db=%DB_NAME% --gzip --archive="%DB_BACKUP_FILE%" >> "%LOG_FILE%" 2>&1

if %ERRORLEVEL% equ 0 (
    echo [%TIMESTAMP%] SUCCESS: MongoDB database backup completed. >> "%LOG_FILE%"
    echo SUCCESS: MongoDB database backup completed.
) else (
    echo [%TIMESTAMP%] WARNING: MongoDB backup returned error code %ERRORLEVEL%. >> "%LOG_FILE%"
    echo WARNING: MongoDB backup returned error code %ERRORLEVEL%.
)

:BACKUP_UPLOADS
:: --- STEP 3: BACKUP UPLOADED ATTACHMENTS ---
set UPLOADS_BACKUP_FILE=%BACKUP_DIR%\uploads_%TIMESTAMP%.tar.gz
if exist "%UPLOADS_DIR%" (
    echo [%TIMESTAMP%] Compressing uploaded attachments to %UPLOADS_BACKUP_FILE%... >> "%LOG_FILE%"
    echo Compressing uploaded attachments...
    tar -czf "%UPLOADS_BACKUP_FILE%" -C "%UPLOADS_DIR%" . >> "%LOG_FILE%" 2>&1
    if %ERRORLEVEL% equ 0 (
        echo [%TIMESTAMP%] SUCCESS: Uploads archive completed. >> "%LOG_FILE%"
        echo SUCCESS: Uploads archive completed.
    ) else (
        echo [%TIMESTAMP%] WARNING: tar archiving returned code %ERRORLEVEL%. >> "%LOG_FILE%"
    )
) else (
    echo [%TIMESTAMP%] Notice: Uploads directory not found at "%UPLOADS_DIR%". >> "%LOG_FILE%"
)

:: --- STEP 4: CLEANUP BACKUPS OLDER THAN RETENTION_DAYS ---
echo [%TIMESTAMP%] Purging backups older than %RETENTION_DAYS% days... >> "%LOG_FILE%"
forfiles /p "%BACKUP_DIR%" /m *.gz /d -%RETENTION_DAYS% /c "cmd /c del /q @path" >nul 2>&1

echo [%TIMESTAMP%] Backup procedure finished successfully. >> "%LOG_FILE%"
echo ======================================================== >> "%LOG_FILE%"
echo Backup procedure finished. Check "%LOG_FILE%" for details.
