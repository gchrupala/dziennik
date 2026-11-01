#!/bin/sh
# Podbija wersję aplikacji (znacznik czasu UTC) we wszystkich adresach plików i w nazwie cache service workera.
# Uruchamiaj przed każdym commitem zmieniającym pliki aplikacji.
set -e
cd "$(dirname "$0")/.."
NEW=$(date -u +%Y%m%d%H%M)
sed -i -E "s/\?v=[0-9]{12}/?v=$NEW/g; s/((APP_)?VERSION = ')[0-9]{12}'/\1$NEW'/" index.html sw.js js/*.js
echo "Wersja: $NEW"
