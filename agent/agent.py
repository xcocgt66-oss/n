import asyncio
import base64
import hashlib
import json
import os
from pathlib import Path
import queue
import secrets
import socket
import subprocess
import sys
import threading
import tkinter as tk
from tkinter import messagebox, ttk
import webbrowser

from bridge import Bridge
from windows_job import ProcessJob

ROOT = Path(sys.executable if getattr(sys, 'frozen', False) else __file__).resolve().parent
CONFIG = ROOT / 'host-config.json'


class Engine:
    def __init__(self, code):
        self.code = code
        self.process = None
        self.log = None
        self.job = None
        self.directory = ROOT / 'vendor' / 'moonlight'

    async def start(self):
        if self.process and self.process.poll() is None:
            return
        executable = self.directory / 'web-server.exe'
        if not executable.exists():
            raise RuntimeError('Run Setup.cmd first: Moonlight Web is missing')
        with socket.socket() as probe:
            if probe.connect_ex(('127.0.0.1', 8099)) == 0:
                raise RuntimeError('Port 8099 is already in use. Close the other host app.')
        config_dir = self.directory / 'server'
        config_dir.mkdir(parents=True, exist_ok=True)
        config_file = config_dir / 'config.json'
        config = json.loads(config_file.read_text('utf-8')) if config_file.exists() else {}
        config['web_server'] = {'bind_address': '127.0.0.1:8099', 'url_path_prefix': '/desktop/' + self.code, 'first_login_create_admin': True, 'first_login_assign_global_hosts': True, 'session_cookie_secure': False}
        config_file.write_text(json.dumps(config, indent=2), 'utf-8')
        self.log = open(ROOT / 'engine.log', 'ab')
        self.process = subprocess.Popen([str(executable)], cwd=self.directory, stdout=self.log, stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            self.job = ProcessJob(self.process.pid)
        except Exception:
            self.process.kill()
            await asyncio.to_thread(self.process.wait)
            self.log.close()
            self.log = None
            self.process = None
            raise RuntimeError('Unable to isolate the engine process tree; access was not started')
        for _ in range(100):
            if self.process.poll() is not None:
                await self.stop()
                raise RuntimeError('Moonlight Web exited. Open engine.log.')
            with socket.socket() as probe:
                if probe.connect_ex(('127.0.0.1', 8099)) == 0:
                    return
            await asyncio.sleep(.1)
        await self.stop()
        raise RuntimeError('Engine start timed out. Open engine.log.')

    async def stop(self):
        if self.job:
            self.job.close()
            self.job = None
        if self.process and self.process.poll() is None:
            process = await asyncio.create_subprocess_exec('taskkill', '/PID', str(self.process.pid), '/T', '/F', stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
            await process.wait()
            await asyncio.to_thread(self.process.wait)
        self.process = None
        if self.log:
            self.log.close()
            self.log = None


class App:
    def __init__(self, window):
        self.window = window
        self.events = queue.Queue()
        self.loop = None
        self.task = None
        self.thread = None
        self.engine = None
        self.closing = False
        self.stop_requested = threading.Event()
        self.config = json.loads(CONFIG.read_text('utf-8')) if CONFIG.exists() else {}
        window.title('S-Power Host')
        window.geometry('620x620')
        window.minsize(550, 600)
        frame = ttk.Frame(window, padding=24)
        frame.pack(fill='both', expand=True)
        ttk.Label(frame, text='S-Power Host', font=('Segoe UI', 22, 'bold')).pack(anchor='w', pady=(0, 12))
        ttk.Label(frame, text='Visible host connection. Stop access disconnects all controllers.').pack(anchor='w')
        self.portal = self.field(frame, 'Portal URL', self.config.get('portal', 'https://'))
        self.enrollment = self.field(frame, 'Pairing code from Remote Access (first setup)', '', True)
        self.password = self.field(frame, 'Device password (blank on first setup = generate securely)', '', True)
        self.code = tk.StringVar(value=self.config.get('code', 'Created on first start'))
        ttk.Label(frame, text='Connection code / Device ID').pack(anchor='w', pady=(14, 2))
        ttk.Entry(frame, textvariable=self.code, state='readonly').pack(fill='x')
        ttk.Button(frame, text='Copy connection code', command=self.copy_code).pack(anchor='w', pady=4)
        buttons = ttk.Frame(frame)
        buttons.pack(fill='x', pady=18)
        self.start_button = ttk.Button(buttons, text='Start access', command=self.start)
        self.start_button.pack(side='left')
        self.stop_button = ttk.Button(buttons, text='Stop access', command=self.stop)
        self.stop_button.pack(side='left', padx=8)
        ttk.Button(buttons, text='Sunshine settings', command=lambda: webbrowser.open('https://localhost:47990')).pack(side='left')
        ttk.Button(buttons, text='Install engines', command=self.setup).pack(side='left', padx=8)
        self.status = tk.StringVar(value='Ready. Install Sunshine as a Windows service before connecting.')
        ttk.Label(frame, textvariable=self.status, wraplength=550).pack(anchor='w')
        ttk.Label(frame, text='Device password is not saved. Device identity and engine pairing are saved.\nKeep this window open while using remote access.', wraplength=550).pack(anchor='w', pady=14)
        window.protocol('WM_DELETE_WINDOW', self.close)
        window.after(100, self.poll)

    def field(self, parent, label, initial, masked=False):
        ttk.Label(parent, text=label).pack(anchor='w', pady=(12, 2))
        value = tk.StringVar(value=initial)
        ttk.Entry(parent, textvariable=value, show='*' if masked else '').pack(fill='x')
        return value

    def save(self):
        temp = CONFIG.with_suffix('.tmp')
        temp.write_text(json.dumps({k: v for k, v in self.config.items() if k != 'enrollment'}, indent=2), 'utf-8')
        os.replace(temp, CONFIG)

    def setup(self):
        # Explicit visible setup; the official installer asks for elevation itself.
        subprocess.Popen(['cmd.exe', '/c', str(ROOT / 'Setup.cmd')], cwd=ROOT,
                         creationflags=subprocess.CREATE_NEW_CONSOLE)

    def copy_code(self):
        if self.code.get().startswith('SP2.'):
            self.window.clipboard_clear()
            self.window.clipboard_append(self.code.get())
            self.status.set('Connection code copied. Keep it private; it grants device access.')
        else:
            messagebox.showinfo('Connection code', 'Enter the existing device password and start access to copy a connection code. You can also use Device ID and password separately.')

    def start(self):
        if self.thread and self.thread.is_alive():
            return
        if not (ROOT / 'vendor' / 'moonlight' / 'web-server.exe').exists():
            messagebox.showerror('Setup required', 'Run Setup.cmd before Start-Host.cmd.')
            return
        password = self.password.get()
        if not self.config:
            password = password or secrets.token_urlsafe(24)
            if len(password) < 12 or len(password) > 128 or not self.enrollment.get().strip():
                messagebox.showerror('First setup', 'Enter a fresh pairing code and a device password of 12–128 characters.')
                return
            secret, salt = secrets.token_hex(32), secrets.token_hex(16)
            self.config = {'secret': secret, 'salt': salt, 'code': hashlib.sha256(bytes.fromhex(secret)).hexdigest()[:10].upper(), 'passwordHash': hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1, dklen=32).hex()}
        self.config['portal'] = self.portal.get().strip().rstrip('/')
        self.config['enrollment'] = self.enrollment.get().strip()
        self.save()
        if password:
            actual = hashlib.scrypt(password.encode(), salt=bytes.fromhex(self.config['salt']), n=16384, r=8, p=1, dklen=32).hex()
            if not secrets.compare_digest(actual, self.config['passwordHash']):
                messagebox.showerror('Device password', 'Use the original device password. It has not been changed.')
                return
            encoded = base64.urlsafe_b64encode(password.encode()).decode().rstrip('=')
            self.code.set('SP2.' + self.config['code'] + '.' + encoded)
        elif not self.code.get().startswith('SP2.'):
            self.code.set(self.config['code'])
        self.password.set('')
        self.enrollment.set('')
        self.start_button.config(state='disabled')
        self.status.set('Connecting to portal…')
        self.stop_requested.clear()
        self.thread = threading.Thread(target=self.worker, daemon=False)
        self.thread.start()

    def worker(self):
        async def run():
            self.loop = asyncio.get_running_loop()
            self.task = asyncio.current_task()
            self.engine = Engine(self.config['code'])
            bridge = Bridge(self.config, self.engine, self.events.put, lambda: self.config.pop('enrollment', None))
            try:
                if self.stop_requested.is_set():
                    return
                await bridge.run()
            finally:
                await self.engine.stop()
        try:
            asyncio.run(run())
        except asyncio.CancelledError:
            pass
        except Exception as error:
            self.events.put(str(error))
        finally:
            self.loop = None
            self.task = None
            self.events.put('Stopped. Remote access is closed.')

    def stop(self):
        self.stop_requested.set()
        if self.loop and self.task:
            self.loop.call_soon_threadsafe(self.task.cancel)
        self.status.set('Stopping…')

    def close(self):
        self.closing = True
        self.stop()

    def poll(self):
        while not self.events.empty():
            self.status.set(self.events.get())
        alive = self.thread and self.thread.is_alive()
        if not alive:
            self.start_button.config(state='normal')
            if self.closing:
                self.window.destroy()
                return
        self.window.after(100, self.poll)


if __name__ == '__main__':
    if os.name != 'nt':
        raise SystemExit('S-Power Host requires Windows 10/11 x64')
    if '--self-test' in sys.argv:
        import ssl
        import aiohttp
        import websockets
        window = tk.Tk()
        window.withdraw()
        window.update()
        window.destroy()
        raise SystemExit(0)
    window = tk.Tk()
    App(window)
    window.mainloop()
