import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from common import ROOT, OUT
import subprocess, time, sys
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8780', '--directory', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errs=[]
def typ(page, sel, text):
    page.locator(sel).click(); page.locator(sel).fill('')
    for k in text: page.keyboard.type(k)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(); page = b.new_page(viewport={'width': 412, 'height': 915}, device_scale_factor=2)
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.goto('http://localhost:8780/')
        page.fill('#nt-tail', 'N12345'); page.click('text=Add aircraft')
        typ(page, '#s-ete', '338'); typ(page, '#s-fuel', '52.8')
        page.click('text=Build plan'); page.click('text=Start flight')
        typ(page, '#sd-at', '200000')
        print('typed 20:00 ->', page.input_value('#sd-at'), '|', page.inner_text('#sdAtOther'))
        print('warning:', page.inner_text('#sheetPreview').replace('\n',' | '))
        page.screenshot(path=f'{OUT}/st1.png', full_page=True)
        page.click('[data-act=saveStart]'); page.wait_for_timeout(100)
        print('save blocked:', page.locator('.sheet h2').count() == 1, '|', page.inner_text('#toast'))
        page.click('[data-act=sdUseGuess]'); page.wait_for_timeout(100)
        print('after fix:', page.input_value('#sd-at'), '|', page.inner_text('#sdAtOther'), '|', page.inner_text('#sheetPreview').replace('\n',' | '))
        page.click('[data-act=saveStart]'); page.wait_for_timeout(300)
        print('fly:', page.inner_text('.top').replace('\n',' ')[-30:], '| total', page.inner_text('.sides .tot .v'))
        # undo start
        page.click('[data-act=resetStart]'); page.click('[data-act=confirmYes]'); page.wait_for_timeout(300)
        print('after undo: start button', page.locator('[data-sheet=start]').count(), '| badge', page.locator('.top .badge').inner_text())
        b.close()
finally: srv.terminate()
print('ERRORS', errs)
