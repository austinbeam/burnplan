import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from common import ROOT, OUT
import subprocess, time, sys
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8801', '--directory', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errs = []
try:
    with sync_playwright() as p:
        b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 412, 'height': 915}, device_scale_factor=2)
        page = ctx.new_page(); page.on('pageerror', lambda e: errs.append(str(e)))
        page.goto('http://localhost:8801/')
        # Guide link on the welcome screen, then on the Plan page once a flight is planned
        page.click('a[href="#guide"]'); page.wait_for_selector('#guideBody h2')
        print('welcome guide:', page.locator('#guideBody h2').first.inner_text(), '| tab on:', page.locator('#tabs a.on').inner_text())
        page.goto('http://localhost:8801/#plan')
        page.fill('#nt-tail', 'N12345'); page.click('text=Add aircraft')
        page.fill('#s-ete', '4:33'); page.locator('#s-ete').dispatch_event('input'); page.fill('#s-fuel', '64'); page.locator('#s-fuel').dispatch_event('input')
        page.click('text=Build plan'); page.wait_for_timeout(200)
        page.click('a[href="#guide"]'); page.wait_for_selector('#guideBody h2')
        h2 = page.locator('#guideBody h2').all_inner_texts()
        print('sections:', h2)
        assert 'Plan a flight' in h2 and 'For developers' not in h2, h2
        imgs = page.evaluate("Promise.all([...document.querySelectorAll('#guideBody img')].map(i => i.decode().then(() => i.naturalWidth).catch(() => 0)))")
        print('images:', imgs); assert len(imgs) == 4 and all(imgs), imgs
        page.screenshot(path=f'{OUT}/guide.png', full_page=True)
        # offline: once the service worker has cached it, the guide still opens with no signal
        page.evaluate('navigator.serviceWorker.ready'); page.wait_for_timeout(1500)
        page.reload(); page.wait_for_timeout(500)
        ctx.set_offline(True)
        page.goto('http://localhost:8801/#guide'); page.reload(); page.wait_for_selector('#guideBody h2', timeout=5000)
        print('offline guide sections:', page.locator('#guideBody h2').count())
        imgs = page.evaluate("Promise.all([...document.querySelectorAll('#guideBody img')].map(i => i.decode().then(() => i.naturalWidth).catch(() => 0)))")
        print('offline images:', imgs); assert all(imgs), imgs
        b.close()
finally: srv.terminate()
print('ERRORS', errs)
