#!/bin/sh
# Creates a self-signed code-signing certificate in your login keychain, once per machine.
# `npm run app` then signs your local build with it, so macOS keeps the privacy permissions
# you grant (Desktop, Documents, Downloads) across rebuilds instead of asking again each time.
# Nothing leaves your machine; the certificate is only trusted for code signing, by you.
#
# Usage: sh scripts/macos-signing.sh     (asks for your password: to trust the certificate, and to
#        let codesign use its key without a keychain prompt on every build)
# Undo:  delete "<app name> local signing" in Keychain Access.
set -eu

[ "$(uname)" = Darwin ] || { echo "Only needed on macOS."; exit 0; }
cd "$(dirname "$0")/.."
NAME="$(node -p "require('./core/tauri.conf.json').productName") local signing"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

# Lets Apple's signing tools use the key silently. Without it, recent macOS asks for the
# keychain password on every build, once per signed file. Prompts for your login password.
allow_codesign() {
  echo "Allowing codesign to use the key without asking (enter your login password)..."
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -l "$NAME" "$KEYCHAIN" >/dev/null
}

if security find-identity -v -p codesigning | grep -q "\"$NAME\""; then
  echo "Certificate \"$NAME\" already exists."
  allow_codesign
  echo "Done. Build with: npm run app"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/cert.cnf" <<CNF
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

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$TMP/cert.cnf" \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" 2>/dev/null

# OpenSSL 3 (e.g. from Homebrew) writes .p12 files the macOS keychain cannot read without -legacy.
LEGACY=""
openssl version | grep -q '^OpenSSL 3' && LEGACY="-legacy"
PASS="$(openssl rand -hex 16)"
openssl pkcs12 -export $LEGACY -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -name "$NAME" \
  -out "$TMP/cert.p12" -passout "pass:$PASS"

# -T lets codesign use the key without a keychain prompt on every build.
security import "$TMP/cert.p12" -k "$KEYCHAIN" -P "$PASS" -T /usr/bin/codesign >/dev/null
echo "Trusting the certificate for code signing (macOS asks for your password)..."
security add-trusted-cert -p codeSign -k "$KEYCHAIN" "$TMP/cert.pem"
allow_codesign

security find-identity -v -p codesigning | grep "\"$NAME\""
echo "Done. Build with: npm run app"
