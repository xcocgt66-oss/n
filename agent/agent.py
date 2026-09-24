import base64
import hashlib
import io
import json
import os
import secrets
import sys
import time
import tkinter as tk
from pathlib import Path
from threading import Event, Thread
from tkinter import messagebox, ttk
from urllib.parse import urlparse

import mss
import pyautogui
from PIL import Image
from websockets.sync.client import connect

if sys.platform != 'win32':
    raise SystemExit('S-Power Host requires Windows')

path = Path(os.environ.get('APPDATA', str(Path.home()))) / 'SPowerAgent' / 'config.json'
path.parent.mkdir(parents=True, exist_ok=True)
config = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
stop = Event()
connection = None
worker = None
pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.01
root = tk.Tk()
root.title('S-Power Host')
root.geometry('490x410')
root.resizable(False, False)
frame = ttk.Frame(root, padding=26)
frame.pack(fill='both', expand=True)
status = tk.StringVar(value='Stopped')
portal = tk.StringVar(value=config.get('gateway', ''))
password = tk.StringVar()
identity = tk.StringVar(value=config.get('code', 'Generated on first start'))


def update(value):
    root.after(0, lambda: status.set(value))


def release():
    for button in ('left', 'right', 'middle'):
        try:
            pyautogui.mouseUp(button=button)
        except Exception:
            pass


def handle(data, monitor):
    kind = data.get('kind')
    if kind == 'release':
        release()
    elif kind in ('move', 'click', 'down', 'up'):
        x, y = data.get('x'), data.get('y')
        if not isinstance(x, (int, float)) or not isinstance(y, (int, float)) or not 0 <= x <= 1 or not 0 <= y <= 1:
            return
        pyautogui.moveTo(monitor['left'] + min(monitor['width'] - 1, int(x * monitor['width'])), monitor['top'] + min(monitor['height'] - 1, int(y * monitor['height'])))
        button = data.get('button')
        if button in ('left', 'right'):
            if kind == 'down':
                pyautogui.mouseDown(button=button)
            elif kind == 'up':
                pyautogui.mouseUp(button=button)
            elif kind == 'click':
                pyautogui.click(button=button)
    elif kind == 'scroll' and data.get('delta') in (-1, 1):
        pyautogui.scroll(-data['delta'] * 3)
    elif kind == 'key':
        mapping = {'Enter': 'enter', 'Backspace': 'backspace', 'Delete': 'delete', 'Tab': 'tab', 'Escape': 'esc', 'ArrowUp': 'up', 'ArrowDown': 'down', 'ArrowLeft': 'left', 'ArrowRight': 'right', ' ': 'space', 'Home': 'home', 'End': 'end', 'PageUp': 'pageup', 'PageDown': 'pagedown'}
        key = mapping.get(data.get('key'), data.get('key'))
        if not isinstance(key, str) or key.lower() not in pyautogui.KEYBOARD_KEYS:
            return
        modifiers = [m for m in ('ctrl', 'alt', 'shift') if data.get(m) is True]
        pyautogui.hotkey(*modifiers, key.lower()) if modifiers else pyautogui.press(key.lower())


def run():
    global connection
    url = config['gateway'].replace('https://', 'wss://', 1) + '/agent'
    while not stop.is_set():
        try:
            update('Connecting…')
            with connect(url, max_size=6_000_000, open_timeout=10, ping_interval=20, ping_timeout=20) as ws:
                connection = ws
                ws.send(json.dumps({'kind': 'register', **{k: config[k] for k in ('code', 'secret', 'salt', 'passwordHash')}}))
                if json.loads(ws.recv(timeout=10)).get('kind') != 'registered':
                    raise RuntimeError('Registration failed')
                update('Online · waiting for your connection')
                active, last = False, 0
                with mss.mss() as capture:
                    monitor = capture.monitors[1]
                    while not stop.is_set():
                        try:
                            data = json.loads(ws.recv(timeout=0.05))
                            if data.get('kind') == 'start':
                                active = True
                                update('REMOTE SESSION ACTIVE')
                            elif data.get('kind') == 'stop':
                                active = False
                                release()
                                update('Online · waiting for your connection')
                            elif active:
                                handle(data, monitor)
                        except TimeoutError:
                            pass
                        if active and time.monotonic() - last >= 0.25:
                            shot = capture.grab(monitor)
                            image = Image.frombytes('RGB', shot.size, shot.rgb)
                            image.thumbnail((1600, 1000))
                            stream = io.BytesIO()
                            image.save(stream, format='JPEG', quality=80)
                            ws.send(json.dumps({'kind': 'frame', 'image': base64.b64encode(stream.getvalue()).decode('ascii')}))
                            last = time.monotonic()
        except pyautogui.FailSafeException:
            stop.set()
            update('Safety stop · mouse reached a screen corner')
        except Exception:
            if not stop.is_set():
                update('Disconnected · retrying in 5 seconds')
                stop.wait(5)
        finally:
            release()
            connection = None
    update('Stopped')


def start():
    global config, worker
    if worker and worker.is_alive():
        return
    gateway = portal.get().strip().rstrip('/')
    parsed = urlparse(gateway)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path:
        return messagebox.showerror('Portal URL', 'Enter the HTTPS origin of your S-Power website, such as https://example.up.railway.app')
    entered = password.get()
    if not config or entered:
        if len(entered) < 12 or len(entered) > 128:
            return messagebox.showerror('Password', 'Choose a device password of 12–128 characters.')
        secret = config.get('secret') or secrets.token_hex(32)
        salt = secrets.token_hex(16)
        config = {'secret': secret, 'salt': salt, 'passwordHash': hashlib.scrypt(entered.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1, dklen=32).hex(), 'code': hashlib.sha256(bytes.fromhex(secret)).hexdigest()[:10].upper()}
    config['gateway'] = gateway
    path.write_text(json.dumps(config), encoding='utf-8')
    identity.set(config['code'])
    password.set('')
    stop.clear()
    worker = Thread(target=run, daemon=True)
    worker.start()


def halt():
    stop.set()
    if connection:
        connection.close()
    status.set('Stopping…')


def close():
    halt()
    root.destroy()


ttk.Label(frame, text='S-POWER HOST', font=('Segoe UI', 18, 'bold')).pack(anchor='w', pady=(0, 16))
ttk.Label(frame, text='Portal HTTPS URL').pack(anchor='w')
ttk.Entry(frame, textvariable=portal, width=58).pack(fill='x', pady=(4, 12))
ttk.Label(frame, text='Device password · leave blank to keep saved password').pack(anchor='w')
ttk.Entry(frame, textvariable=password, show='•', width=58).pack(fill='x', pady=(4, 12))
ttk.Label(frame, text='Device ID').pack(anchor='w')
ttk.Entry(frame, textvariable=identity, state='readonly', font=('Consolas', 14)).pack(fill='x', pady=(4, 12))
ttk.Label(frame, textvariable=status).pack(anchor='w', pady=(0, 12))
controls = ttk.Frame(frame)
controls.pack(fill='x')
ttk.Button(controls, text='Start host', command=start).pack(side='left', padx=(0, 10))
ttk.Button(controls, text='Stop access', command=halt).pack(side='left')
ttk.Label(frame, text='Keep this window open. Closing it stops remote access.').pack(anchor='w', pady=15)
root.protocol('WM_DELETE_WINDOW', close)
root.mainloop()
