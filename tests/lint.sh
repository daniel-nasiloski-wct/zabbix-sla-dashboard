#!/bin/sh
# php -l em todo o PHP (php:8.1-cli, o mínimo do Zabbix 8.0), node --check no JS e sh -n no instalador.
set -eu
cd "$(dirname "$0")/.."
docker run --rm -v "$PWD/sla_dashboard":/m -w /m php:8.1-cli sh -c \
	'for f in $(find . -name "*.php"); do php -l "$f" >/dev/null || exit 1; done; echo "php ok"'
node --check sla_dashboard/assets/js/sla-dashboard.js && echo "js ok"
sh -n install.sh && echo "install.sh ok"
