import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from common import ROOT, OUT
import subprocess, time, sys
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8775', '--directory', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errs=[]; M=60000
try:
    with sync_playwright() as p:
        b = p.chromium.launch(); page = b.new_page(viewport={'width': 412, 'height': 915}, device_scale_factor=2)
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.clock.install(time=time.mktime((2026, 10, 23, 13, 0, 0, 0, 0, -1)))
        page.goto('http://localhost:8775/')
        page.fill('#nt-tail', 'N12345'); page.click('text=Add aircraft')
        page.fill('#s-ete', '1:30'); page.locator('#s-ete').dispatch_event('input'); page.fill('#s-fuel', '27'); page.locator('#s-fuel').dispatch_event('input')
        page.click('text=Build plan'); page.click('text=Start flight'); page.locator('#sd-at').fill('0:00'); page.locator('#sd-at').dispatch_event('input'); page.click('[data-act=saveStart]')
        page.clock.run_for(200*M); page.wait_for_timeout(300)
        page.click('[data-sheet=shutdown]'); page.wait_for_timeout(100)
        print('picks:', page.locator('[data-act=sdAtMs]').all_inner_texts(), '| default:', page.input_value('#sd-at'))
        page.locator('#sd-at').fill('1:25'); page.locator('#sd-at').dispatch_event('input')
        print('preview:', page.inner_text('#sheetPreview').replace('\n',' | '))
        page.screenshot(path=f'{OUT}/end1.png', full_page=True)
        page.fill('#sd-used', '26.1'); page.click('[data-act=saveShutdown]'); page.wait_for_timeout(300)
        print('log url:', page.url.split('#')[1][:3], '| summary:', page.locator('.card').first.inner_text().replace('\n',' | ')[:160])
        print('events:', [t.replace('\n',' / ') for t in page.locator('.evrow.tap').all_inner_texts()][-1])
        # correct the shutdown later
        page.locator('.evrow.tap', has_text='Shutdown').click(); page.locator('#sd-at').fill('1:31'); page.locator('#sd-at').dispatch_event('input'); page.click('[data-act=saveEdit]'); page.wait_for_timeout(200)
        print('after edit:', page.locator('.card').first.inner_text().replace('\n',' | ')[:80])
        b.close()
finally: srv.terminate()
print('ERRORS', errs)
