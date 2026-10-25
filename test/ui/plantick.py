import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from common import ROOT, OUT
import subprocess, time, sys
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8786', '--directory', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errs=[]; M=60000
def typ(page, sel, text):
    page.locator(sel).click(); page.locator(sel).fill('')
    for k in text: page.keyboard.type(k)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(); page = b.new_page(viewport={'width': 412, 'height': 915})
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.clock.install(time=time.mktime((2026, 10, 25, 7, 0, 0, 0, 0, -1)))
        page.goto('http://localhost:8786/')
        page.fill('#nt-tail', 'N12345'); page.click('text=Add aircraft')
        typ(page, '#s-ete', '338'); typ(page, '#s-fuel', '52.8'); page.click('text=Build plan'); page.click('text=Start flight')
        typ(page, '#sd-at', '13000'); page.click('[data-act=saveStart]'); page.wait_for_timeout(200)
        page.goto('http://localhost:8786/#plan'); page.wait_for_timeout(200)
        mark = lambda: (page.inner_text('.nowlbl'), page.locator('.nowmark').get_attribute('style'))
        print('t0:', mark())
        page.clock.run_for(3*M); page.wait_for_timeout(300)
        print('t+3m:', mark())
        # editing a leg blocks refresh
        page.locator('[data-leg-min]').first.click()
        page.clock.run_for(2*M); page.wait_for_timeout(300)
        print('while editing:', mark()[0], '| still focused:', page.evaluate("document.activeElement.dataset.legMin !== undefined"))
        page.locator('[data-leg-min]').first.blur(); page.clock.run_for(1*M); page.wait_for_timeout(300)
        print('after blur:', mark()[0])
        b.close()
finally: srv.terminate()
print('ERRORS', errs)
