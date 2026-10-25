import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from common import ROOT, OUT
import subprocess, time, sys
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8776', '--directory', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errs=[]; M=60000
def start(page, ete):
    page.fill('#s-ete', ete); page.locator('#s-ete').dispatch_event('input'); page.fill('#s-fuel', '40'); page.locator('#s-fuel').dispatch_event('input')
    page.click('text=Build plan'); page.click('text=Start flight'); page.locator('#sd-at').fill('0:00'); page.locator('#sd-at').dispatch_event('input'); page.click('[data-act=saveStart]'); page.wait_for_timeout(200)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(); page = b.new_page(viewport={'width': 412, 'height': 915}, device_scale_factor=2)
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.clock.install(time=time.mktime((2026, 10, 23, 13, 0, 0, 0, 0, -1)))
        page.goto('http://localhost:8776/')
        page.fill('#nt-tail', 'N12345'); page.click('text=Add aircraft')
        start(page, '2:00')
        page.clock.run_for(40*M); page.click('[data-sheet=shutdown]'); page.click('[data-act=sdNow]'); page.click('[data-act=saveShutdown]'); page.wait_for_timeout(300)
        print('ended, on:', page.url.split('#')[1][:3])
        page.clock.run_for(10*M)
        page.click('[data-act=reactivate]'); page.click('[data-act=confirmYes]'); page.wait_for_timeout(300)
        print('reactivated -> sheet:', page.locator('.sheet h2').inner_text(), '| toast:', page.inner_text('#toast')[:40])
        page.click('[data-act=closeSheet]'); page.wait_for_timeout(200)
        print('fly header:', page.inner_text('.top').replace('\n',' ')[:90], '| total:', page.inner_text('.sides .tot .v'))
        page.goto('http://localhost:8776/#log'); page.wait_for_timeout(200); page.click('.item'); page.wait_for_timeout(200)
        print('events:', [t.split('\n')[0] for t in page.locator('.evrow.tap').all_inner_texts()])
        # second flight can't reactivate while one is active: end it, make another, then try
        page.goto('http://localhost:8776/#fly'); page.wait_for_timeout(200)
        page.click('[data-sheet=shutdown]'); page.click('[data-act=sdNow]'); page.click('[data-act=saveShutdown]'); page.wait_for_timeout(300)
        page.goto('http://localhost:8776/#setup'); page.wait_for_timeout(200); start(page, '1:00')
        page.goto('http://localhost:8776/#log'); page.wait_for_timeout(200); page.locator('.item').nth(1).click(); page.wait_for_timeout(200)
        page.click('[data-act=reactivate]'); page.wait_for_timeout(100)
        print('blocked toast:', page.inner_text('#toast'))
        b.close()
finally: srv.terminate()
print('ERRORS', errs)
