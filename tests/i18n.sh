#!/bin/bash
# Compila os .po do módulo em .mo (msgfmt; no Mac: brew install gettext) e falha se algum idioma não
# tiver todos os msgids do .pot ou tiver tradução vazia. Rodar depois de mexer em qualquer texto.
set -eu
cd "$(dirname "$0")/../sla_dashboard/locale"
POT=sla_dashboard.pot
expected=$(sed -n 's/^msgid "\(..*\)"$/\1/p' "$POT" | sort)
fail=0
count=0
for po in */LC_MESSAGES/sla_dashboard.po; do
	lang=${po%%/*}
	got=$(sed -n 's/^msgid "\(..*\)"$/\1/p' "$po" | sort)
	if [ "$got" != "$expected" ]; then
		echo "$lang: msgids diferentes do .pot"; diff <(echo "$expected") <(echo "$got") 2>/dev/null || true; fail=1
	fi
	if msgfmt --statistics -c -o "${po%.po}.mo" "$po" 2>&1 | grep -q "untranslated\|fuzzy"; then
		echo "$lang: tradução faltando"; fail=1
	fi
	count=$((count + 1))
done
echo "$count idiomas compilados"
exit $fail
