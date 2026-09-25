import asyncio
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import uuid

import aiohttp

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'agent'))
from bridge import Bridge


class Engine:
    async def start(self):
        pass

    async def stop(self):
        pass


class Link:
    def __init__(self):
        self.items = []

    async def send(self, data):
        self.items.append(data if isinstance(data, bytes) else json.loads(data))


async def main():
    package = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory() as temporary:
        code = '012345ABCD'
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        configuration = {'web_server': {'bind_address': f'127.0.0.1:{port}', 'url_path_prefix': '/desktop/' + code, 'first_login_create_admin': True, 'first_login_assign_global_hosts': True}, 'data_storage': {'type': 'json', 'path': str(Path(temporary) / 'storage.json'), 'session_expiration_check_interval': {'secs': 60, 'nanos': 0}}}
        config_path = Path(temporary) / 'config.json'
        config_path.write_text(json.dumps(configuration))
        log = open(Path(temporary) / 'engine.log', 'wb')
        process = subprocess.Popen([str(package / 'web-server'), '--config-path', str(config_path)], cwd=package, stdout=log, stderr=log)
        try:
            bridge = Bridge({'code': code}, Engine())
            bridge.base = f'http://127.0.0.1:{port}'
            bridge.link = Link()
            async with aiohttp.ClientSession(cookie_jar=aiohttp.DummyCookieJar(), auto_decompress=False) as bridge.http:
                ready = False
                for _ in range(100):
                    try:
                        async with bridge.http.get(bridge.base + bridge.prefix + '/') as response:
                            if response.status == 200:
                                ready = True
                                break
                    except aiohttp.ClientError:
                        pass
                    if process.poll() is not None:
                        break
                    await asyncio.sleep(.1)
                if not ready:
                    log.flush()
                    raise RuntimeError((Path(temporary) / 'engine.log').read_text())
                await bridge.begin({'id': str(uuid.uuid4()), 'password': 'test-device-password'})
                assert bridge.active and bridge.cookie
                assert bridge.link.items[-1]['kind'] == 'session-ready'
                for route in ('/', '/config.js', '/index.js', '/api/authenticate'):
                    channel = {'credits': asyncio.Semaphore(100)}
                    identifier = str(uuid.uuid4())
                    bridge.link.items.clear()
                    await bridge.http_request({'id': identifier, 'method': 'GET', 'path': bridge.prefix + route, 'headers': {}, 'body': ''}, channel)
                    assert bridge.link.items[0]['kind'] == 'headers', bridge.link.items
                    assert bridge.link.items[0]['status'] == 200, (route, bridge.link.items)
                    assert bridge.link.items[-1]['kind'] == 'end'
                    content = b''.join(v[17:] for v in bridge.link.items if isinstance(v, bytes))
                    if route == '/config.js':
                        assert bridge.prefix.encode() in content
                    print('PASS real Moonlight auth + bridge', route, len(content))
                for path in ('https://example.com', '/api/login', bridge.prefix + '/../api/login', bridge.prefix + '/%2e%2e/api/login', '//example.com/a'):
                    try:
                        bridge.target(path)
                        raise AssertionError('Unsafe target accepted')
                    except ValueError:
                        pass
                print('PASS bridge rejects paths outside its loopback prefix')
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            log.close()


asyncio.run(main())
