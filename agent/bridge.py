"""
Host bridge — connects to the S-Power portal via SSE (receive commands)
and HTTP POST (send data back). No WebSocket needed.
"""

import asyncio
import base64
import json
import uuid
from urllib.parse import urlsplit, unquote

import aiohttp


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
        self.portal_origin = None
        self.http = None

    async def post_data(self, header, payload=b''):
        """Send data back to the portal via HTTP POST."""
        header['code'] = self.config['code']
        body = json.dumps(header).encode('utf-8') + b'\n' + payload
        try:
            async with self.http.post(
                self.portal_origin + '/api/host/data',
                data=body,
                headers={'Content-Type': 'application/octet-stream'},
                timeout=aiohttp.ClientTimeout(total=30)
            ) as resp:
                return resp.status == 200
        except Exception:
            return False

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
            async with self.http.post(
                self.base + self.prefix + '/api/login',
                json={'name': 'spower', 'password': message['password']},
                allow_redirects=False
            ) as response:
                cookie = response.cookies.get('mlSession')
                if response.status != 200 or not cookie:
                    raise RuntimeError('Local engine login failed; use the original device password')
                self.cookie = cookie.value
            self.active = True
            self.status('Controller connected. Stop access ends the session.')
            await self.post_data({
                'kind': 'session-ready',
                'id': message['id'],
                'cookie': self.cookie,
                'sessionId': str(uuid.uuid4()),
            })
        except Exception as error:
            self.status(str(error))
            await self.post_data({'kind': 'session-error', 'id': message['id']})

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
        await self.post_data({'kind': 'session-ended'})
        self.status('Host online. Waiting for a controller.')

    async def http_request(self, message, channel):
        identifier = message['id']
        try:
            async with self.http.request(
                message['method'],
                self.target(message['path']),
                headers=self.headers(message.get('headers', {})),
                data=base64.b64decode(message.get('body', ''), validate=True),
                allow_redirects=False
            ) as response:
                headers = {
                    k.lower(): v for k, v in response.headers.items()
                    if k.lower() in ('content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'location')
                }
                await self.post_data({
                    'kind': 'headers',
                    'id': identifier,
                    'status': response.status,
                    'headers': headers,
                })
                async for chunk in response.content.iter_chunked(65536):
                    await channel['credits'].acquire()
                    await self.post_data({'kind': 'chunk', 'id': identifier}, chunk)
                await self.post_data({'kind': 'end', 'id': identifier})
        except asyncio.CancelledError:
            raise
        except Exception:
            await self.post_data({'kind': 'error', 'id': identifier})
        finally:
            self.channels.pop(identifier, None)

    async def run(self):
        parsed = urlsplit(self.config['portal'])
        if parsed.scheme != 'https' or not parsed.netloc or parsed.username or parsed.password or parsed.path not in ('', '/') or parsed.query or parsed.fragment:
            raise ValueError('Use the HTTPS portal origin, without a page path')

        self.portal_origin = f'https://{parsed.netloc}'
        sse_url = self.portal_origin + '/api/host/events'
        params = {
            'code': self.config['code'],
            'secret': self.config['secret'],
            'salt': self.config['salt'],
            'passwordHash': self.config['passwordHash'],
            'enrollment': self.config.get('enrollment', ''),
        }

        timeout = aiohttp.ClientTimeout(total=None, sock_connect=10, sock_read=90)
        async with aiohttp.ClientSession(
            timeout=timeout,
            cookie_jar=aiohttp.DummyCookieJar(),
            auto_decompress=False,
            trust_env=False
        ) as self.http:
            while True:
                try:
                    self.status('Connecting to portal...')
                    async with self.http.get(sse_url, params=params, timeout=aiohttp.ClientTimeout(total=None, sock_connect=15)) as resp:
                        if resp.status != 200:
                            body = await resp.text()
                            raise RuntimeError(f'SSE connection failed: {resp.status} {body[:200]}')

                        self.status('SSE connected, waiting for events...')
                        buffer = ''
                        event_type = ''
                        event_data = ''

                        async for line_bytes in resp.content:
                            line = line_bytes.decode('utf-8', errors='replace').rstrip('\n').rstrip('\r')

                            if line.startswith(':'):
                                # Comment / keepalive
                                continue
                            elif line.startswith('event: '):
                                event_type = line[7:]
                            elif line.startswith('data: '):
                                event_data = line[6:]
                            elif line == '' and event_data:
                                # End of event
                                if event_type == 'cmd':
                                    try:
                                        message = json.loads(event_data)
                                    except json.JSONDecodeError:
                                        event_type = ''
                                        event_data = ''
                                        continue

                                    kind = message.get('kind')
                                    identifier = message.get('id')

                                    if kind == 'registered':
                                        self.registered()
                                        self.status('Host online. Waiting for a controller.')
                                    elif kind == 'begin-session':
                                        await self.begin(message)
                                    elif kind == 'end-session':
                                        await self.end()
                                    elif kind == 'credit':
                                        channel = self.channels.get(identifier)
                                        if channel and 'credits' in channel:
                                            channel['credits'].release()
                                    elif kind == 'http':
                                        if not self.active or not self.cookie or len(self.channels) >= 64:
                                            await self.post_data({'kind': 'error', 'id': identifier})
                                        else:
                                            try:
                                                uuid.UUID(identifier)
                                                self.target(message['path'])
                                                channel = {'credits': asyncio.Semaphore(8)}
                                                self.channels[identifier] = channel
                                                channel['task'] = asyncio.create_task(
                                                    self.http_request(message, channel)
                                                )
                                            except Exception:
                                                await self.post_data({'kind': 'error', 'id': identifier})
                                    elif kind == 'error':
                                        raise ValueError(message.get('message', 'Host registration rejected'))

                                event_type = ''
                                event_data = ''

                except asyncio.CancelledError:
                    raise
                except Exception as error:
                    self.status('Disconnected: ' + str(error)[:160])
                finally:
                    await self.end()

                self.status('Reconnecting in 5 seconds. Check portal URL and pairing code.')
                await asyncio.sleep(5)
