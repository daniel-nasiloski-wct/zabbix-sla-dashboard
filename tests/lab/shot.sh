#!/bin/sh
# shot.sh <url-relativa> <png> [opções do shot.mjs] — screenshot logado como Admin (Chrome headless).
set -e
URL="http://localhost:8090/$1"; OUT="$2"; shift 2
JAR=$(mktemp)
curl -s -c "$JAR" -b "$JAR" -o /dev/null -d 'name=Admin&password=zabbix&enter=Sign+in' http://localhost:8090/index.php
SID=$(awk '$6=="zbx_session"{print $7}' "$JAR"); rm -f "$JAR"
node "$(dirname "$0")/../shot.mjs" "$URL" "$OUT" --cookie "zbx_session=$SID" "$@"
