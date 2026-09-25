import asyncio
import base64
import json
import uuid
from urllib.parse import urlsplit, unquote

import aiohttp
import websockets


class Bridge:
    def __init__(self, config, engine, status=print, registered=lambda: None):
        self.config = config
        self.engine = engine
        self.status = status
        self.registered = registered
        self.prefix = '/desktop/' + config['code']
        self.base = 'http://127.0.0.1:8099'
        self.cookie = None
        self.channels = {}
        self.active = False
        self.lock = asyncio.Lock()
        self.link = None

    async def send(self, message):
        async with self.lock:
            await self.link.send(message if isinstance(message, bytes) else json.dumps(message))

    def target(self, path):
        parsed = urlsplit(path)
        decoded = unquote(parsed.path)
        if parsed.scheme or parsed.netloc or not decoded.startswith(self.prefix + '/') or '\\' in decoded or any(part in ('.', '..') for part in decoded.split('/')):
            raise ValueError('Invalid local path')
        return self.base + path

    def headers(self, supplied):
        result = {k: v for k, v in supplied.items() if k.lower() in ('content-type', 'accept', 'range', 'if-none-match')}
        result['Cookie'] = 'mlSession=' + self.cookie
        return result

    async def begin(self, message):
        try:
            await self.engine.start()
            async with self.http.post(self.base + self.prefix + '/api/login', json={'name': 'spower', 'password': message['password']}, allow_redirects=False) as response:
                cookie = response.cookies.get('mlSession')
                if response.status != 200 or not cookie:
                    raise RuntimeError('Local engine login failed; use the original device password')
                self.cookie = cookie.value
            self.active = True
            self.status('Controller connected. Stop access ends the session.')
            await self.send({'kind': 'session-ready', 'id': message['id']})
        except Exception as error:
            self.status(str(error))
            await self.send({'kind': 'error', 'id': message['id']})

    async def close_channel(self, identifier):
        channel = self.channels.pop(identifier, None)
        if channel:
            channel['task'].cancel()
            await asyncio.gather(channel['task'], return_exceptions=True)

    async def end(self):
        self.active = False
        self.cookie = None
        for identifier in list(self.channels):
            await self.close_channel(identifier)
        await self.engine.stop()
        self.status('Host online. Waiting for a controller.')

    async def http_request(self, message, channel):
        identifier = message['id']
        try:
            async with self.http.request(message['method'], self.target(message['path']), headers=self.headers(message.get('headers', {})), data=base64.b64decode(message.get('body', ''), validate=True), allow_redirects=False) as response:
                headers = {k.lower(): v for k, v in response.headers.items() if k.lower() in ('content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'location')}
                await self.send({'kind': 'headers', 'id': identifier, 'status': response.status, 'headers': headers})
                async for chunk in response.content.iter_chunked(65536):
                    await channel['credits'].acquire()
                    await self.send(bytes([1]) + uuid.UUID(identifier).bytes + chunk)
                await self.send({'kind': 'end', 'id': identifier})
        except asyncio.CancelledError:
            raise
        except Exception:
            await self.send({'kind': 'error', 'id': identifier})
        finally:
            self.channels.pop(identifier, None)

    async def socket_request(self, message, channel):
        identifier = message['id']
        try:
            async with self.http.ws_connect(self.target(message['path']), headers=self.headers(message.get('headers', {})), protocols=message.get('protocols', []), max_msg_size=8 * 1024 * 1024, compress=0, autoclose=True) as local:
                async def outgoing():
                    while True:
                        kind, payload = await channel['queue'].get()
                        if kind == 3:
                            await local.send_bytes(payload)
                        else:
                            await local.send_str(payload.decode('utf-8'))
                writer = asyncio.create_task(outgoing())
                try:
                    async for data in local:
                        if data.type == aiohttp.WSMsgType.TEXT:
                            await self.send(bytes([2]) + uuid.UUID(identifier).bytes + data.data.encode('utf-8'))
                        elif data.type == aiohttp.WSMsgType.BINARY:
                            await self.send(bytes([3]) + uuid.UUID(identifier).bytes + data.data)
                        elif data.type == aiohttp.WSMsgType.ERROR:
                            break
                finally:
                    writer.cancel()
                    await asyncio.gather(writer, return_exceptions=True)
        except asyncio.CancelledError:
            raise
        except Exception:
            self.status('A stream channel closed. Check engine.log if this repeats.')
        finally:
            self.channels.pop(identifier, None)
            await self.send({'kind': 'closed', 'id': identifier})

    async def run(self):
        parsed = urlsplit(self.config['portal'])
        if parsed.scheme != 'https' or not parsed.netloc or parsed.username or parsed.password or parsed.path not in ('', '/') or parsed.query or parsed.fragment:
            raise ValueError('Use the HTTPS portal origin, without a page path')
        endpoint = 'wss://' + parsed.netloc + '/host-link'
        timeout = aiohttp.ClientTimeout(total=None, sock_connect=10, sock_read=60)
        async with aiohttp.ClientSession(timeout=timeout, cookie_jar=aiohttp.DummyCookieJar(), auto_decompress=False, trust_env=False) as self.http:
            while True:
                try:
                    async with websockets.connect(endpoint, max_size=8 * 1024 * 1024, max_queue=8, compression=None, ping_interval=20, ping_timeout=20, open_timeout=15) as self.link:
                        await self.send({'kind': 'register', **{key: self.config[key] for key in ('code', 'secret', 'salt', 'passwordHash')}, 'enrollment': self.config.get('enrollment', '')})
                        async for raw in self.link:
                            if isinstance(raw, bytes):
                                if len(raw) < 17:
                                    raise ValueError('Invalid packet')
                                identifier = str(uuid.UUID(bytes=raw[1:17]))
                                channel = self.channels.get(identifier)
                                if channel and 'queue' in channel:
                                    try:
                                        channel['queue'].put_nowait((raw[0], raw[17:]))
                                    except asyncio.QueueFull:
                                        await self.close_channel(identifier)
                                continue
                            message = json.loads(raw)
                            kind, identifier = message.get('kind'), message.get('id')
                            if kind == 'registered':
                                self.registered()
                                self.status('Host online. Waiting for a controller.')
                            elif kind == 'begin-session':
                                await self.begin(message)
                            elif kind == 'end-session':
                                await self.end()
                            elif kind == 'close':
                                await self.close_channel(identifier)
                            elif kind == 'credit':
                                channel = self.channels.get(identifier)
                                if channel and 'credits' in channel:
                                    channel['credits'].release()
                            elif kind in ('http', 'ws'):
                                if not self.active or not self.cookie or len(self.channels) >= 64:
                                    await self.send({'kind': 'error', 'id': identifier})
                                    continue
                                uuid.UUID(identifier)
                                self.target(message['path'])
                                channel = {'credits': asyncio.Semaphore(8)} if kind == 'http' else {'queue': asyncio.Queue(8)}
                                self.channels[identifier] = channel
                                handler = self.http_request if kind == 'http' else self.socket_request
                                channel['task'] = asyncio.create_task(handler(message, channel))
                            elif kind == 'error':
                                raise ValueError(message.get('message', 'Host registration rejected'))
                except asyncio.CancelledError:
                    raise
                except Exception as error:
                    self.status('Disconnected: ' + str(error)[:160])
                finally:
                    await self.end()
                self.status('Reconnecting in 5 seconds. Check portal URL and pairing code.')
                await asyncio.sleep(5)
