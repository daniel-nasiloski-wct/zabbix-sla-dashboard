#!/usr/bin/env python3
"""Chamada avulsa à API do lab: api.py <método> '<json>'."""
import json, sys, urllib.request

URL = 'http://localhost:8090/api_jsonrpc.php'
_token = None


def call(method, params=None):
    global _token
    if _token is None and method != 'user.login':
        _token = call('user.login', {'username': 'Admin', 'password': 'zabbix'})
    body = {'jsonrpc': '2.0', 'method': method, 'params': params or {}, 'id': 1}
    req = urllib.request.Request(URL, json.dumps(body).encode(), {'Content-Type': 'application/json-rpc'})
    if _token and method != 'user.login':
        req.add_header('Authorization', 'Bearer ' + _token)
    res = json.load(urllib.request.urlopen(req))
    if 'error' in res:
        raise RuntimeError(f"{method}: {res['error']}")
    return res['result']


if __name__ == '__main__':
    print(json.dumps(call(sys.argv[1], json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}), indent=1))
