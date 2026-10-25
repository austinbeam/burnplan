import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from common import ROOT, OUT
import subprocess, time, sys
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8770', '--directory', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errs=[]
try:
    with sync_playwright() as p:
        b = p.chromium.launch(); page = b.new_page(viewport={'width': 412, 'height': 915}, device_scale_factor=2)
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.clock.install(time=time.mktime((2026, 10, 23, 13, 0, 0, 0, 0, -1)))
        page.goto('http://localhost:8770/')
        page.fill('#nt-tail', 'N12345'); page.click('text=Add aircraft')
        page.fill('#s-ete', '4:33'); page.fill('#s-fuel', '70.9'); page.locator('#s-fuel').dispatch_event('input')
        page.click('text=Build plan'); page.clock.run_for(100*60*1000)
        page.click('text=Start flight'); page.locator('#sd-at').fill('1:20'); page.locator('#sd-at').dispatch_event('input')
        page.click('[data-act=sdSofar][data-v=manual]'); page.click('[data-act=saveStart]'); page.wait_for_timeout(200)
        page.goto('http://localhost:8770/#plan'); page.wait_for_timeout(200)
        print('whole: past rows', page.locator('.legrow.past').count(), '| axis', page.inner_text('.axis'))
        page.screenshot(path=f'{OUT}/v1.png')
        page.click('[data-act=planView][data-v=remaining]'); page.wait_for_timeout(100)
        print('remaining: past rows', page.locator('.legrow.past').count(), '| axis', page.inner_text('.axis'))
        page.screenshot(path=f'{OUT}/v2.png')
        page.reload(); page.wait_for_timeout(200)
        print('remembered:', page.locator('.seg button.on').inner_text())
        b.close()
finally: srv.terminate()
print('ERRORS', errs)
