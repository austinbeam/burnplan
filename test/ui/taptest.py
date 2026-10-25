import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from common import ROOT, OUT
import subprocess, time, sys
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8768', '--directory', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errs=[]
try:
    with sync_playwright() as p:
        b = p.chromium.launch(); page = b.new_page(viewport={'width': 412, 'height': 915})
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.goto('http://localhost:8768/')
        page.fill('#nt-tail', 'N12345'); page.click('text=Add aircraft')
        page.fill('#s-ete', '4:33'); page.fill('#s-fuel', '70.9'); page.locator('#s-fuel').dispatch_event('input')
        page.click('text=Build plan'); page.click('text=Start flight')
        page.locator('#sd-at').fill('0:30'); page.locator('#sd-at').dispatch_event('input')
        page.click('[data-act=saveStart]'); page.wait_for_timeout(200)
        page.click('[data-act=tapTank][data-tank=LM]'); page.wait_for_timeout(100)
        print('tap current:', page.inner_text('#toast'), '| sheet open:', page.locator('.sheet').count())
        page.click('[data-act=tapTank][data-tank=RT]'); page.wait_for_timeout(100)
        print('tap RT -> sheet:', page.locator('.sheet h2').inner_text(), '| selected:', page.locator('.tankpick button.sel .t').inner_text())
        page.screenshot(path=OUT+'/tap.png')
        b.close()
finally: srv.terminate()
print('ERRORS', errs)
