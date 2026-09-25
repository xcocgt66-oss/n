import asyncio
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'agent'))
import bridge

configuration = json.loads(sys.stdin.readline())
connect = bridge.websockets.connect


def local_connection(url, **kwargs):
    assert url == configuration['portal'].replace('https:', 'wss:') + '/host-link'
    return connect(url.replace('wss:', 'ws:', 1), **kwargs)


class Engine:
    async def start(self):
        pass

    async def stop(self):
        pass


bridge.websockets.connect = local_connection
asyncio.run(bridge.Bridge(configuration, Engine(), lambda text: print(text, flush=True), lambda: print('REGISTERED', flush=True)).run())
