import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from common import ROOT, OUT
import subprocess, time, sys
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8784', '--directory', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errs=[]
def typ(page, sel, text):
    page.locator(sel).click(); page.locator(sel).fill('')
    for k in text: page.keyboard.type(k)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(); page = b.new_page(viewport={'width': 412, 'height': 915}, device_scale_factor=2)
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.clock.install(time=time.mktime((2026, 10, 25, 7, 0, 0, 0, 0, -1)))
        page.goto('http://localhost:8784/')
        page.fill('#nt-tail', 'N12345'); page.click('text=Add aircraft')
        typ(page, '#s-from', 'KLUK'); typ(page, '#s-to', 'KVBT')
        typ(page, '#s-ete', '338'); typ(page, '#s-fuel', '52.8'); page.click('text=Build plan'); page.click('text=Start flight')
        typ(page, '#sd-at', '13000'); page.click('[data-act=saveStart]'); page.wait_for_timeout(300)
        page.screenshot(path=f'{OUT}/lay.png', full_page=True)
        for sel in ['[data-sheet=switch]','[data-sheet=climb]','[data-sheet=burn]','[data-sheet=check]','[data-sheet=ete]','[data-sheet=shutdown]','[data-act=resetStart]']:
            page.click(sel); page.wait_for_timeout(80)
            print(sel, '->', page.locator('.sheet h2').inner_text() if page.locator('.sheet h2').count() else 'no sheet')
            page.keyboard.press('Escape'); page.wait_for_timeout(80)
        b.close()
finally: srv.terminate()
print('ERRORS', errs)
