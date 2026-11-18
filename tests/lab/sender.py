#!/usr/bin/env python3
"""zabbix_sender mínimo: sender.py <host> <valor> — grava no item trapper "health" (0 = OK)."""
import json, socket, struct, sys

host, value = sys.argv[1], sys.argv[2]
body = json.dumps({'request': 'sender data', 'data': [{'host': host, 'key': 'health', 'value': value}]}).encode()
with socket.create_connection(('localhost', 10051), timeout=10) as s:
    s.sendall(b'ZBXD\x01' + struct.pack('<II', len(body), 0) + body)
    resp = s.recv(4096)
print(resp[13:].decode())
