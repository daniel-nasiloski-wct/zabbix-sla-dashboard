#!/usr/bin/env python3
"""Cenário whitelabel: um provedor ("Whitelabel Hosting") com N clientes, cada um com Website, E-mail
e Database; 2 SLAs por plano (premium/standard) e ~400 dias de histórico em service_alarms.
Roda depois do seed.py; pode rodar de novo (apaga o que ele criou). Só para o lab.

    python3 seed_whitelabel.py [--customers 12]
"""
import argparse
import json
import random
import time

from api import call
from seed import psql

DAYS = 400
NOW = int(time.time())
START = NOW - DAYS * 86400
TZ = 'America/Sao_Paulo'
ROOT = 'Whitelabel Hosting'
NAMES = ['Padaria Pão Quente', 'Clínica Vida', 'Auto Peças Silva', 'Escola Aprender', 'Advocacia Lima',
         'Pet Shop Amigo', 'Hotel Serra Azul', 'Farmácia Popular Sul', 'Construtora Alfa', 'Imobiliária Casa Nova',
         'Restaurante Sabor', 'Academia Força', 'Ótica Visão', 'Contabilidade Exata', 'Floricultura Jardim',
         'Gráfica Rápida', 'Livraria Página', 'Mercado Bom Preço', 'Oficina Motor', 'Studio Foto Arte']
NAMES += [f'Cliente {i:02d}' for i in range(21, 61)]
COMPONENTS = [('Website', 'web', 5, 20), ('E-mail', 'mail', 4, 30), ('Database', 'database', 2, 40)]
SLAS = [
    {'name': 'Whitelabel Premium 99.9% monthly', 'period': 2, 'slo': '99.9', 'plan': 'premium'},
    {'name': 'Whitelabel Standard 99.5% monthly', 'period': 2, 'slo': '99.5', 'plan': 'standard'},
]
ALARM_BASE = 950000000


def timeline(per_year, avg_min, rnd):
    events, t = [], START
    while True:
        t += int(rnd.expovariate(per_year / (365 * 86400)))
        if t >= NOW - 3600:
            break
        dur = max(60, int(rnd.lognormvariate(0, 0.9) * avg_min * 60))
        events += [(t, rnd.choice([3, 4, 4, 5])), (min(t + dur, NOW - 600), -1)]
        t += dur
    return events


def worst_of(children):
    changes = sorted({c for ch in children for c, _ in ch})
    out, prev = [], -1
    for clock in changes:
        state = -1
        for ch in children:
            cur = -1
            for c, v in ch:
                if c > clock:
                    break
                cur = v
            state = max(state, cur)
        if state != prev:
            out.append((clock, state))
            prev = state
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--customers', type=int, default=12)
    args = ap.parse_args()
    rnd = random.Random(7)

    old = [s['serviceid'] for s in call('service.get', {'output': ['serviceid'], 'tags': [{'tag': 'seed', 'value': 'whitelabel', 'operator': 1}]})]
    if old:
        call('service.delete', old)
    old = [s['slaid'] for s in call('sla.get', {'output': ['slaid'], 'filter': {'name': [s['name'] for s in SLAS]}})]
    if old:
        call('sla.delete', old)

    seed_tag = {'tag': 'seed', 'value': 'whitelabel'}
    root = call('service.create', {'name': ROOT, 'algorithm': 2, 'sortorder': 0,
                                   'tags': [seed_tag, {'tag': 'layer', 'value': 'provider'}]})['serviceids'][0]
    histories = {}
    for i, name in enumerate(NAMES[:args.customers]):
        slug = f'c{i + 1:02d}'
        plan = 'premium' if i % 5 in (0, 3) else 'standard'
        # alguns clientes com infra pior, para o painel ter o que mostrar
        factor = 3.5 if i in (2, 7) else 1
        tags = [seed_tag, {'tag': 'customer', 'value': slug}, {'tag': 'plan', 'value': plan}]
        child_ids, child_hist = [], []
        for comp, svc_tag, per_year, avg_min in COMPONENTS:
            cid = call('service.create', {
                'name': comp, 'algorithm': 2, 'sortorder': len(child_ids),
                'tags': tags + [{'tag': 'layer', 'value': 'technical'}],
                'problem_tags': [{'tag': 'customer', 'operator': 0, 'value': slug},
                                 {'tag': 'service', 'operator': 0, 'value': svc_tag}]
            })['serviceids'][0]
            hist = timeline(per_year * factor, avg_min, rnd)
            histories[cid] = hist
            child_ids.append(cid)
            child_hist.append(hist)
        cust = call('service.create', {
            'name': name, 'algorithm': 2, 'sortorder': i,
            'tags': tags + [{'tag': 'layer', 'value': 'business'}],
            'parents': [{'serviceid': root}], 'children': [{'serviceid': c} for c in child_ids]
        })['serviceids'][0]
        histories[cust] = worst_of(child_hist)
    histories[root] = worst_of(list(histories.values()))

    for s in SLAS:
        call('sla.create', {'name': s['name'], 'period': s['period'], 'slo': s['slo'], 'effective_date': START,
                            'timezone': TZ, 'status': 1,
                            'service_tags': [{'tag': 'plan', 'operator': 0, 'value': s['plan']}]})

    rows, aid = [], ALARM_BASE
    for sid, events in histories.items():
        for clock, value in events:
            aid += 1
            rows.append(f'({aid},{sid},{clock},{value})')
    sql = [f'UPDATE services SET created_at={START} WHERE serviceid IN ({",".join(histories)});',
           f'DELETE FROM service_alarms WHERE servicealarmid >= {ALARM_BASE};']
    for i in range(0, len(rows), 500):
        sql.append('INSERT INTO service_alarms (servicealarmid,serviceid,clock,value) VALUES ' + ','.join(rows[i:i + 500]) + ';')
    psql('\n'.join(sql))
    print(json.dumps({'customers': args.customers, 'services': len(histories), 'alarms': len(rows)}))


if __name__ == '__main__':
    main()
