import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from common import ROOT, OUT
# Installed-app update path: a new deploy must reach an open app without a manual reload, and the app must load offline.
import subprocess, time, re, shutil, tempfile
from playwright.sync_api import sync_playwright
SITE = tempfile.mkdtemp(prefix='burnplan-sw-')
for f in ['index.html', 'app.css', 'manifest.webmanifest', 'sw.js', 'js', 'icons', 'README.md', 'docs']:  # same files the Pages deploy stages
    (shutil.copytree if os.path.isdir(os.path.join(ROOT, f)) else shutil.copy)(os.path.join(ROOT, f), os.path.join(SITE, f))
def setver(v):
    for f, pat, rep in [('sw.js', r"const VERSION = '[^']*'", f"const VERSION = 'burnplan-{v}'"), ('js/app.js', r"APP_VERSION = '[^']*'", f"APP_VERSION = '{v}'")]:
        p = os.path.join(SITE, f); s = open(p).read(); open(p, 'w').write(re.sub(pat, rep, s, count=1))
setver('v900')
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8794', '--directory', SITE], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errs = []
def ver(page):
    page.goto('http://localhost:8794/#aircraft'); page.wait_for_timeout(500)
    m = re.search(r'Burnplan (v\d+) · build', page.inner_text('#app')); return m.group(1) if m else None
try:
    with sync_playwright() as p:
        b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 412, 'height': 915}); page = ctx.new_page()
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.goto('http://localhost:8794/'); page.wait_for_timeout(1500)
        page.reload(); page.wait_for_timeout(800)
        v1 = ver(page); print('first load version:', v1, '| controlled:', page.evaluate('!!navigator.serviceWorker.controller'))
        setver('v901')
        page.evaluate("navigator.serviceWorker.getRegistration().then(r => r.update())")
        page.wait_for_timeout(3000)
        txt = page.inner_text('#app')
        v2 = re.search(r'Burnplan (v\d+) · build', txt).group(1) if 'Burnplan v' in txt else ver(page)
        print('after update check, version on screen (no manual reload):', v2)
        ctx.set_offline(True); page.reload(); page.wait_for_timeout(800)
        v3 = ver(page); print('offline load ok:', 'Burnplan' in page.title(), v3)
        if (v1, v2, v3) != ('v900', 'v901', 'v901'): errs.append(f'update path broken: {v1} -> {v2} -> {v3}')
        b.close()
finally:
    srv.terminate(); shutil.rmtree(SITE, ignore_errors=True)
print('ERRORS', errs)
