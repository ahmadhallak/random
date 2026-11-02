#!/usr/bin/env bash
# سكربت رفع مشروع راندوم شات إلى مستودع Git تلقائياً

set -e

REPO_URL="$1"

if [ -z "$REPO_URL" ]; then
  echo "🔗 يرجى إدخال رابط المستودع (مثال: https://github.com/username/repo.git):"
  read -r REPO_URL
fi

if [ -z "$REPO_URL" ]; then
  echo "❌ خطأ: لم يتم تزويد رابط المستودع."
  exit 1
fi

echo "🚀 جارٍ تهيئة مستودع Git المحلي..."
git init

# التأكد من تسمية الفرع الرئيسي main
git checkout -B main

echo "📦 إضافة جميع ملفات المشروع..."
git add .

echo "📝 إنشاء Commit..."
git commit -m "feat: initial commit of Random Video Chat WebRTC & Socket.io platform" || true

# إضافة أو تحديث الرابط البعيد origin
if git remote | grep -q "^origin$"; then
  git remote set-url origin "$REPO_URL"
else
  git remote add origin "$REPO_URL"
fi

echo "⬆️ جارٍ رفع الملفات إلى المستودع البعيد (git push)..."
git push -u origin main

echo "✅ تم رفع المشروع بنجاح إلى: $REPO_URL"
