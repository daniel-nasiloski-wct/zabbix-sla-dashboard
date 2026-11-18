#!/usr/bin/env python3
"""Testa os filtros do módulo no lab (host, grupo, tag, serviço, agrupamentos)."""
import http.cookiejar, json, urllib.parse, urllib.request
from api import call

BASE = 'http://localhost:8090/'
jar = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
op.open(BASE + 'index.php', urllib.parse.urlencode({'name': 'Admin', 'password': 'zabbix', 'enter': 'Sign in'}).encode())


def run(params):
    op.open(BASE + 'zabbix.php?' + urllib.parse.urlencode([('action', 'sladashboard.view'), ('filter_set', 1)] + params)).read()
    d = json.loads(op.open(BASE + 'zabbix.php?action=sladashboard.data').read())
    return sorted({d['services'][r['serviceid']]['name'] for r in d['rows']}), len(d['buckets']), d['truncated'], d['errors']


host = call('host.get', {'output': ['hostid'], 'filter': {'host': 'pay-gw-01'}})[0]['hostid']
grp = call('hostgroup.get', {'output': ['groupid'], 'filter': {'name': 'Network'}})[0]['groupid']
svc = call('service.get', {'output': ['serviceid'], 'filter': {'name': 'ERP'}})[0]['serviceid']
print('host pay-gw-01  ', run([('filter_hostids[]', host)]))
print('group Network   ', run([('filter_groupids[]', grp)]))
print('tag layer=business', run([('filter_tags[0][tag]', 'layer'), ('filter_tags[0][value]', 'business'), ('filter_tags[0][operator]', 1)]))
print('service ERP     ', run([('filter_serviceids[]', svc)]))
print('hour default    ', run([('filter_period', 0)])[1:])
print('week default    ', run([('filter_period', 2)])[1:])
print('month default   ', run([('filter_period', 3)])[1:])
print('year default    ', run([('filter_period', 4)])[1:])
print('hour 1 year     ', run([('filter_period', 0), ('filter_date_from', '2025-11-01')])[1:])
print('bad dates       ', run([('filter_date_from', '2026-11-10'), ('filter_date_to', '2026-11-01')])[1:])
op.open(BASE + 'zabbix.php?action=sladashboard.view&filter_rst=1').read()
