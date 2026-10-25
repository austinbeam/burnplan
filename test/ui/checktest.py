import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from common import ROOT, OUT
import subprocess, time, sys
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8783', '--directory', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errs=[]; M=60000
def typ(page, sel, text):
    page.locator(sel).click(); page.locator(sel).fill('')
    for k in text: page.keyboard.type(k)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(); page = b.new_page(viewport={'width': 412, 'height': 915}, device_scale_factor=2)
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.clock.install(time=time.mktime((2026, 10, 25, 7, 0, 0, 0, 0, -1)))
        page.goto('http://localhost:8783/')
        page.fill('#nt-tail', 'N12345'); page.click('text=Add aircraft')
        typ(page, '#s-ete', '338'); typ(page, '#s-fuel', '52.8'); page.click('text=Build plan'); page.click('text=Start flight')
        typ(page, '#sd-at', '13000'); page.click('[data-act=saveStart]'); page.wait_for_timeout(200)
        page.click('[data-sheet=check]'); typ(page, '#sd-used', '24'); typ(page, '#sd-gph', '14.6')
        page.click('details.explain summary'); page.wait_for_timeout(100)
        print('preview:', page.inner_text('#sheetPreview').replace('\n',' | '))
        page.screenshot(path=f'{OUT}/chk.png', full_page=True)
        page.click('[data-act=saveCheck]'); page.wait_for_timeout(300)
        print('toast:', page.inner_text('#toast'), '| phase:', page.locator('#flyLive .card').filter(has_text='Set burn').inner_text().split('\n')[0])
        b.close()
finally: srv.terminate()
print('ERRORS', errs)
