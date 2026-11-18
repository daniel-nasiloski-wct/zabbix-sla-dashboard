#!/usr/bin/env python3
"""Confere o SLI do módulo contra o sla.getsli do Zabbix: cada SLA agrupada pelo próprio período
(diário/semanal/mensal), mesmos intervalos. Imprime a maior diferença por SLA."""
import http.cookiejar, json, urllib.parse, urllib.request
from api import call

BASE = 'http://localhost:8090/'
jar = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
op.open(BASE + 'index.php', urllib.parse.urlencode({'name': 'Admin', 'password': 'zabbix', 'enter': 'Sign in'}).encode())

PERIOD = {'0': 1, '1': 2, '2': 3}  # período da SLA → agrupamento do módulo (dia, semana, mês)
ok = True
for sla in call('sla.get', {'output': ['slaid', 'name', 'period']}):
    q = urllib.parse.urlencode({'action': 'sladashboard.view', 'filter_set': 1, 'filter_slaids[]': sla['slaid'],
                                'filter_period': PERIOD[sla['period']], 'filter_date_from': '2026-01-01'})
    op.open(BASE + 'zabbix.php?' + q).read()
    data = json.loads(op.open(BASE + 'zabbix.php?action=sladashboard.data').read())
    ref = call('sla.getsli', {'slaid': sla['slaid'], 'period_from': data['buckets'][0]['from'],
                              'period_to': data['buckets'][-1]['to'] - 1})
    starts = [p['period_from'] for p in ref['periods']]
    worst, n = 0.0, 0
    for row in data['rows']:
        si = ref['serviceids'].index(int(row['serviceid']))
        for b, cell in zip(data['buckets'], row['cells']):
            if b['from'] not in starts:
                continue
            r = ref['sli'][starts.index(b['from'])][si]['sli']
            mine = cell[0] if cell else -1
            worst = max(worst, abs(mine - r)); n += 1
    print(f"{sla['name']}: {n} células, períodos {len(data['buckets'])}/{len(starts)}, maior diferença {worst:.6f}")
    ok &= worst < 0.001
op.open(BASE + 'zabbix.php?action=sladashboard.view&filter_rst=1').read()
print('OK' if ok else 'DIVERGE')
