import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from common import ROOT, OUT
import subprocess, time, sys
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8787', '--directory', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errs=[]; M=60000
def typ(page, sel, text):
    page.locator(sel).click(); page.locator(sel).fill('')
    for k in text: page.keyboard.type(k)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(); page = b.new_page(viewport={'width': 412, 'height': 915}, device_scale_factor=2)
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.clock.install(time=time.mktime((2026, 10, 25, 7, 0, 0, 0, 0, -1)))
        page.goto('http://localhost:8787/')
        page.fill('#nt-tail', 'N12345'); page.click('text=Add aircraft')
        typ(page, '#s-from', 'KLUK'); typ(page, '#s-to', 'KVBT')
        typ(page, '#s-ete', '338'); typ(page, '#s-fuel', '52.8'); page.click('text=Build plan'); page.click('text=Start flight')
        typ(page, '#sd-at', '4900'); page.click('[data-act=saveStart]'); page.wait_for_timeout(300)
        fly = page.inner_text('#flyLive')
        print('fly imbalance line:', [l for l in fly.split('\n') if 'Imbalance' in l])
        page.goto('http://localhost:8787/#plan'); page.wait_for_timeout(300)
        print('header:', page.locator('.row.between.small.mut').first.inner_text())
        print('flown rows:', [t.split('\n')[:7] for t in page.locator('.legrow.past').all_inner_texts()])
        print('plan rows Δ:', [t.split('\n')[6] if len(t.split('\n'))>6 else t for t in page.locator('.legrow:not(.head):not(.past):not(.short)').all_inner_texts()])
        page.screenshot(path=f'{OUT}/delta.png', full_page=True)
        b.close()
finally: srv.terminate()
print('ERRORS', errs)
