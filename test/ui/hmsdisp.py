import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from common import ROOT, OUT
import subprocess, time, sys
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8793', '--directory', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errs=[]
def typ(page, sel, text):
    page.locator(sel).click(); page.locator(sel).fill('')
    for k in text: page.keyboard.type(k)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(); page = b.new_page(viewport={'width': 412, 'height': 915}, device_scale_factor=2)
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.clock.install(time=time.mktime((2026, 10, 25, 7, 0, 0, 0, 0, -1)))
        page.goto('http://localhost:8793/')
        page.fill('#nt-tail', 'N12345'); page.click('text=Add aircraft')
        typ(page, '#s-ete', '329'); typ(page, '#s-fuel', '52.8'); page.click('text=Build plan'); page.click('text=Start flight')
        typ(page, '#sd-at', '13015'); page.click('[data-act=saveStart]'); page.wait_for_timeout(300)
        card = lambda: page.locator('#flyLive .card', has_text='Next planned switch').inner_text().replace('\n',' | ')
        print('t0:', card(), '| elapsed', page.inner_text('#elapsed'))
        page.clock.run_for(3000); page.wait_for_timeout(1200)
        print('t+3s:', card(), '| elapsed', page.inner_text('#elapsed'), '| field', page.input_value('#flyTime'))
        page.locator('#flyLive .card', has_text='Next planned switch').screenshot(path=OUT+'/next.png')
        b.close()
finally: srv.terminate()
print('ERRORS', errs)
