import base64
import hashlib
import io
import json
import os
import secrets
import sys
import time
from getpass import getpass
from pathlib import Path
from threading import Thread
from urllib.request import Request, urlopen
from urllib.parse import urlparse

import mss
import pyautogui
from PIL import Image
from websockets.sync.client import connect

if sys.platform != 'win32':
    raise SystemExit('This agent runs on Windows only')

path = Path(os.environ.get('APPDATA', str(Path.home()))) / 'SPowerAgent' / 'config.json'
path.parent.mkdir(parents=True, exist_ok=True)
if path.exists():
    config = json.loads(path.read_text(encoding='utf-8'))
else:
    gateway = input('Portal HTTPS URL: ').strip().rstrip('/')
    u = urlparse(gateway)
    if u.scheme != 'https' or not u.hostname:
        raise SystemExit('Use a public HTTPS portal URL')
    password = getpass('Choose a strong device password: ')
    if len(password) < 12:
        raise SystemExit('Device password must have at least 12 characters')
    secret = secrets.token_hex(32)
    salt = secrets.token_hex(16)
    config = {
        'gateway': gateway,
        'secret': secret,
        'salt': salt,
        'passwordHash': hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1, dklen=32).hex(),
        'code': hashlib.sha256(bytes.fromhex(secret)).hexdigest()[:10].upper()
    }
    path.write_text(json.dumps(config), encoding='utf-8')

url = config['gateway'].replace('https://', 'wss://', 1) + '/agent'
print('S-Power agent running. Close this window to stop remote access.')
print('Device code:', config['code'])
pyautogui.FAILSAFE = True

def handle(data, monitor):
    kind = data.get('kind')
    if kind in ('move', 'click'):
        x = data.get('x')
        y = data.get('y')
        if not isinstance(x, (int, float)) or not isinstance(y, (int, float)) or not 0 <= x <= 1 or not 0 <= y <= 1:
            return
        px = monitor['left'] + min(monitor['width'] - 1, int(x * monitor['width']))
        py = monitor['top'] + min(monitor['height'] - 1, int(y * monitor['height']))
        pyautogui.moveTo(px, py)
        if kind == 'click' and data.get('button') in ('left', 'right'):
            pyautogui.click(button=data['button'])
    elif kind == 'scroll' and data.get('delta') in (-1, 1):
        pyautogui.scroll(-data['delta'] * 3)
    elif kind == 'key':
        key = data.get('key')
        mapping = {'Enter': 'enter', 'Backspace': 'backspace', 'Delete': 'delete', 'Tab': 'tab', 'Escape': 'esc', 'ArrowUp': 'up', 'ArrowDown': 'down', 'ArrowLeft': 'left', 'ArrowRight': 'right', ' ': 'space', 'Home': 'home', 'End': 'end', 'PageUp': 'pageup', 'PageDown': 'pagedown'}
        key = mapping.get(key, key)
        if not isinstance(key, str) or (len(key) != 1 and key not in mapping.values()):
            return
        modifiers = [m for flag, m in (('ctrl', 'ctrl'), ('alt', 'alt'), ('shift', 'shift')) if data.get(flag) is True]
        if modifiers:
            pyautogui.hotkey(*modifiers, key)
        else:
            pyautogui.press(key)

def local_ai(ws, request):
    request_id = request.get('requestId')
    if not isinstance(request_id, str) or len(request_id) > 50:
        return
    try:
        if request.get('model') != 'qwen3-vl:32b':
            raise ValueError('Unsupported local model')
        history = request.get('history')
        if not isinstance(history, list) or not 1 <= len(history) <= 12:
            raise ValueError('Invalid conversation')
        messages = []
        for turn in history:
            if turn.get('role') not in ('user', 'assistant') or not isinstance(turn.get('text'), str):
                raise ValueError('Invalid conversation')
            messages.append({'role': turn['role'], 'content': turn['text'][:4000]})
        image = request.get('image')
        if image:
            if not isinstance(image, str) or len(image) > 3_500_000:
                raise ValueError('Image too large')
            messages[-1]['images'] = [image]
        payload = json.dumps({'model': 'qwen3-vl:32b', 'messages': messages, 'stream': False, 'options': {'num_predict': 2048}}).encode()
        call = Request('http://127.0.0.1:11434/api/chat', data=payload, headers={'Content-Type': 'application/json'}, method='POST')
        with urlopen(call, timeout=110) as response:
            result = json.load(response)
        answer = result.get('message', {}).get('content', '')
        if not isinstance(answer, str) or not answer:
            raise ValueError('Local model returned no text')
        ws.send(json.dumps({'kind': 'ai-result', 'requestId': request_id, 'answer': answer[:30000]}))
    except Exception as exc:
        try:
            ws.send(json.dumps({'kind': 'ai-result', 'requestId': request_id, 'error': str(exc)[:140]}))
        except Exception:
            pass

while True:
    try:
        with connect(url, max_size=6_000_000, open_timeout=10, ping_interval=20, ping_timeout=20) as ws:
            ws.send(json.dumps({'kind': 'register', **{k: config[k] for k in ('code', 'secret', 'salt', 'passwordHash')}}))
            reply = json.loads(ws.recv(timeout=10))
            if reply.get('kind') != 'registered':
                raise RuntimeError('Registration failed')
            print('Connected to portal')
            active = False
            last = 0
            with mss.mss() as capture:
                monitor = capture.monitors[1]
                while True:
                    try:
                        data = json.loads(ws.recv(timeout=0.1))
                        if data.get('kind') == 'start':
                            active = True
                            print('Remote session started')
                        elif data.get('kind') == 'stop':
                            active = False
                            print('Remote session ended')
                        elif data.get('kind') == 'ai-request':
                            Thread(target=local_ai, args=(ws, data), daemon=True).start()
                        elif active:
                            handle(data, monitor)
                    except TimeoutError:
                        pass
                    if active and time.monotonic() - last >= 0.6:
                        frame = Image.frombytes('RGB', (monitor['width'], monitor['height']), capture.grab(monitor).rgb)
                        frame.thumbnail((1280, 800))
                        stream = io.BytesIO()
                        frame.save(stream, format='JPEG', quality=60)
                        ws.send(json.dumps({'kind': 'frame', 'image': base64.b64encode(stream.getvalue()).decode('ascii')}))
                        last = time.monotonic()
    except KeyboardInterrupt:
        print('Agent stopped')
        break
    except Exception as exc:
        print('Connection lost:', str(exc)[:100])
        time.sleep(5)
