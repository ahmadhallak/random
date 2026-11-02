@echo off
chcp 65001 >nul
setlocal

set REPO_URL=%~1
if "%REPO_URL%"=="" (
    set /p REPO_URL="🔗 يرجى إدخال رابط المستودع (مثال: https://github.com/username/repo.git): "
)

if "%REPO_URL%"=="" (
    echo ❌ خطأ: لم يتم تزويد رابط المستودع.
    exit /b 1
)

echo 🚀 جارٍ تهيئة مستودع Git المحلي...
git init
git checkout -B main

echo 📦 إضافة جميع ملفات المشروع...
git add .

echo 📝 إنشاء Commit...
git commit -m "feat: initial commit of Random Video Chat WebRTC & Socket.io platform"

git remote remove origin >nul 2>&1
git remote add origin "%REPO_URL%"

echo ⬆️ جارٍ رفع الملفات إلى المستودع البعيد (git push)...
git push -u origin main

echo ✅ تم رفع المشروع بنجاح إلى: %REPO_URL%
pause
