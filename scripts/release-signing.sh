#!/bin/sh
# Maintainers only, once per project: creates the certificate that signs tine's macOS releases
# and stores it as GitHub Actions secrets. macOS ties privacy permissions (Full Disk Access,
# Desktop, Documents...) to this signature, so users grant them once and keep them across
# every update. It is self-signed: Gatekeeper still asks users to confirm the first launch.
#
# Keep the backup this writes. Losing it means a new certificate, and every user is asked again.
#
# Usage: sh scripts/release-signing.sh [owner/repo]    (needs openssl and a logged-in gh)
set -eu

cd "$(dirname "$0")/.."
NAME="$(node -p "require('./core/tauri.conf.json').productName") release signing"
REPO="${1:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
BACKUP="$HOME/.config/$(node -p "require('./core/tauri.conf.json').productName")-release-signing"

if [ -e "$BACKUP/cert.p12" ]; then
  echo "A release certificate already exists in $BACKUP; reusing it."
  PASS="$(cat "$BACKUP/password")"
else
  mkdir -p "$BACKUP" && chmod 700 "$BACKUP"
  cat > "$BACKUP/cert.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CNF
  # 20 years: the certificate must outlive every release signed with it.
  openssl req -x509 -newkey rsa:2048 -nodes -days 7300 -config "$BACKUP/cert.cnf" \
    -keyout "$BACKUP/key.pem" -out "$BACKUP/cert.pem" 2>/dev/null
  # OpenSSL 3 writes .p12 files the macOS keychain cannot read without -legacy.
  LEGACY=""
  openssl version | grep -q '^OpenSSL 3' && LEGACY="-legacy"
  PASS="$(openssl rand -hex 16)"
  printf %s "$PASS" > "$BACKUP/password"
  openssl pkcs12 -export $LEGACY -inkey "$BACKUP/key.pem" -in "$BACKUP/cert.pem" -name "$NAME" \
    -out "$BACKUP/cert.p12" -passout "pass:$PASS"
  rm "$BACKUP/key.pem" "$BACKUP/cert.cnf"
  chmod 600 "$BACKUP"/*
fi

base64 < "$BACKUP/cert.p12" | tr -d '\n' | gh secret set APPLE_CERTIFICATE --repo "$REPO"
printf %s "$PASS" | gh secret set APPLE_CERTIFICATE_PASSWORD --repo "$REPO"
printf %s "$NAME" | gh secret set APPLE_SIGNING_IDENTITY --repo "$REPO"
echo "Done: $REPO signs macOS releases as \"$NAME\". Back up $BACKUP somewhere safe."
