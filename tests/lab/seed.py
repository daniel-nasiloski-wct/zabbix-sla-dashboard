#!/usr/bin/env python3
"""Popula o lab: grupos, hosts com trapper + triggers, árvore de serviços, 3 SLAs e ~400 dias de
histórico de status dos serviços (tabela service_alarms, gravada direto no PostgreSQL do lab).

Pode rodar de novo: apaga o que ele mesmo criou (pelos nomes) e recria. Só para o lab.
"""
import json
import random
import subprocess
import time

from api import call

DAYS = 400
NOW = int(time.time())
START = NOW - DAYS * 86400
TZ = 'America/Sao_Paulo'
random.seed(42)

GROUPS = ['Web servers', 'Databases', 'Network', 'Payments', 'ERP', 'Mail']

# host: (grupo, tag service dos triggers)
HOSTS = {
    'web-01': ('Web servers', 'web'),
    'web-02': ('Web servers', 'web'),
    'db-01': ('Databases', 'database'),
    'db-02': ('Databases', 'database'),
    'pay-api-01': ('Payments', 'payments'),
    'pay-gw-01': ('Payments', 'payments'),
    'fw-01': ('Network', 'firewall'),
    'sw-core-01': ('Network', 'core-switch'),
    'erp-app-01': ('ERP', 'erp'),
    'mail-01': ('Mail', 'mail'),
}

# Serviço folha: (problem tag service, tier, incidentes/ano, duração média em min)
LEAVES = {
    'Frontend web': ('web', 'gold', 14, 25),
    'Database cluster': ('database', 'gold', 5, 40),
    'Payments': ('payments', 'gold', 26, 30),
    'Firewall': ('firewall', 'silver', 6, 50),
    'Core switch': ('core-switch', 'silver', 9, 90),
    'ERP application': ('erp', 'gold', 8, 120),
    'Mail server': ('mail', 'bronze', 30, 45),
}
# Serviço pai: (tier, área de negócio, filhos)
PARENTS = {
    'Online store': ('gold', 'ecommerce', ['Frontend web', 'Database cluster', 'Payments']),
    'Network infrastructure': ('silver', 'infrastructure', ['Firewall', 'Core switch']),
    'ERP': ('gold', 'backoffice', ['ERP application', 'Database cluster']),
    'Corporate e-mail': ('bronze', 'collaboration', ['Mail server']),
}
SLAS = [
    {'name': 'Gold 99.9% monthly', 'period': 2, 'slo': '99.9', 'tier': 'gold'},
    {'name': 'Silver 99.5% weekly (business hours)', 'period': 1, 'slo': '99.5', 'tier': 'silver',
     # seg a sex, 08:00 às 18:00 (segundos desde domingo 00:00)
     'schedule': [{'period_from': d * 86400 + 8 * 3600, 'period_to': d * 86400 + 18 * 3600} for d in range(1, 6)]},
    {'name': 'Bronze 99% daily', 'period': 0, 'slo': '99', 'tier': 'bronze'},
]


def psql(sql):
    return subprocess.run(['docker', 'exec', '-i', 'slalab-db', 'psql', '-U', 'zabbix', '-d', 'zabbix', '-qtA'],
                          input=sql, capture_output=True, text=True, check=True).stdout


def ids(method, key, names, field='name'):
    if not names:
        return []
    return [r[key] for r in call(method, {'output': [key], 'filter': {field: names}})]


def cleanup():
    sla_ids = ids('sla.get', 'slaid', [s['name'] for s in SLAS])
    if sla_ids:
        call('sla.delete', sla_ids)
    svc = ids('service.get', 'serviceid', list(LEAVES) + list(PARENTS))
    if svc:
        call('service.delete', svc)
    hosts = ids('host.get', 'hostid', list(HOSTS), 'host')
    if hosts:
        call('host.delete', hosts)


def main():
    cleanup()

    groups = {}
    for g in GROUPS:
        found = call('hostgroup.get', {'output': ['groupid'], 'filter': {'name': g}})
        groups[g] = found[0]['groupid'] if found else call('hostgroup.create', {'name': g})['groupids'][0]

    for host, (group, svc_tag) in HOSTS.items():
        hostid = call('host.create', {
            'host': host, 'groups': [{'groupid': groups[group]}],
            'tags': [{'tag': 'env', 'value': 'prod'}, {'tag': 'site', 'value': 'sao-paulo' if host[-1] == '1' else 'rio'}]
        })['hostids'][0]
        call('item.create', {'hostid': hostid, 'name': 'Health status (0 = OK)', 'key_': 'health',
                             'type': 2, 'value_type': 3, 'trapper_hosts': '0.0.0.0/0', 'tags': [{'tag': 'component', 'value': 'health'}]})
        call('trigger.create', {
            'description': f'{host}: service unavailable', 'expression': f'last(/{host}/health)>0',
            'priority': 4, 'tags': [{'tag': 'service', 'value': svc_tag}, {'tag': 'scope', 'value': 'availability'}]
        })

    svc_ids = {}
    for name, (tag, tier, _, _) in LEAVES.items():
        svc_ids[name] = call('service.create', {
            'name': name, 'algorithm': 2, 'sortorder': 0,
            'tags': [{'tag': 'tier', 'value': tier}, {'tag': 'layer', 'value': 'technical'}],
            'problem_tags': [{'tag': 'service', 'operator': 0, 'value': tag}]
        })['serviceids'][0]
    for name, (tier, area, children) in PARENTS.items():
        svc_ids[name] = call('service.create', {
            'name': name, 'algorithm': 2, 'sortorder': 0,
            'tags': [{'tag': 'tier', 'value': tier}, {'tag': 'layer', 'value': 'business'},
                     {'tag': 'area', 'value': area}],
            'children': [{'serviceid': svc_ids[c]} for c in children]
        })['serviceids'][0]

    for s in SLAS:
        call('sla.create', {
            'name': s['name'], 'period': s['period'], 'slo': s['slo'], 'effective_date': START,
            'timezone': TZ, 'status': 1, 'service_tags': [{'tag': 'tier', 'operator': 0, 'value': s['tier']}],
            'schedule': s.get('schedule', []),
            'excluded_downtimes': [{'name': 'Datacenter power maintenance',
                                    'period_from': NOW - 40 * 86400, 'period_to': NOW - 40 * 86400 + 4 * 3600}]
            if s['tier'] == 'gold' else []
        })

    # Histórico: incidentes aleatórios por serviço folha; o pai fica com o pior estado dos filhos.
    timelines = {}
    for name, (_, _, per_year, avg_min) in LEAVES.items():
        events, t = [], START
        while True:
            t += int(random.expovariate(per_year / (365 * 86400)))
            if t >= NOW - 3600:
                break
            dur = max(60, int(random.lognormvariate(0, 0.9) * avg_min * 60))
            sev = random.choice([3, 4, 4, 5])
            events.append((t, sev))
            events.append((min(t + dur, NOW - 600), -1))
            t += dur
        timelines[name] = events
    # Um mês ruim no ERP (para aparecer uma quebra clara no gráfico).
    bad = NOW - 75 * 86400
    timelines['ERP application'] += [(bad, 5), (bad + 9 * 3600, -1)]
    timelines['ERP application'].sort()

    for name, (_, _, children) in PARENTS.items():
        changes = sorted({c for ch in children for c, _ in timelines[ch]})
        out, prev = [], -1
        for clock in changes:
            state = -1
            for ch in children:
                cur = -1
                for c, v in timelines[ch]:
                    if c > clock:
                        break
                    cur = v
                state = max(state, cur)
            if state != prev:
                out.append((clock, state))
                prev = state
        timelines[name] = out

    rows, alarm_id = [], 900000000
    for name, events in timelines.items():
        for clock, value in events:
            alarm_id += 1
            rows.append(f'({alarm_id},{svc_ids[name]},{clock},{value})')
    sql = [f'UPDATE services SET created_at={START} WHERE serviceid IN ({",".join(svc_ids.values())});',
           f'DELETE FROM service_alarms WHERE servicealarmid >= 900000000;']
    for i in range(0, len(rows), 500):
        sql.append('INSERT INTO service_alarms (servicealarmid,serviceid,clock,value) VALUES '
                   + ','.join(rows[i:i + 500]) + ';')
    psql('\n'.join(sql))

    print(json.dumps({'services': len(svc_ids), 'alarms': len(rows), 'hosts': len(HOSTS)}))


if __name__ == '__main__':
    main()
