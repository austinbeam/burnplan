import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from common import ROOT, OUT
import subprocess, time, sys
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8791', '--directory', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errs=[]
def typ(page, sel, text):
    page.locator(sel).click(); page.locator(sel).fill('')
    for k in text: page.keyboard.type(k)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(); page = b.new_page(viewport={'width': 412, 'height': 915})
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.goto('http://localhost:8791/')
        page.fill('#nt-tail', 'N12345'); page.click('text=Add aircraft')
        typ(page, '#s-ete', '329'); typ(page, '#s-fuel', '52.8'); page.click('text=Build plan'); page.click('text=Start flight')
        typ(page, '#sd-at', '13000'); page.click('[data-act=saveStart]'); page.wait_for_timeout(200)
        page.click('[data-sheet=ete]'); page.wait_for_timeout(100)
        print('label:', page.locator('label[for=sd-gph]').inner_text(), '| placeholder:', page.get_attribute('#sd-gph', 'placeholder'))
        typ(page, '#sd-ete', '200'); print('preview:', page.inner_text('#sheetPreview').replace('\n',' | ')[:160])
        b.close()
finally: srv.terminate()
print('ERRORS', errs)
