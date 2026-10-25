import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from common import ROOT, OUT
import subprocess, time, sys, json
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8789', '--directory', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errs=[]; M=60000
def typ(page, sel, text):
    page.locator(sel).click(); page.locator(sel).fill('')
    for k in text: page.keyboard.type(k)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 412, 'height': 915}, device_scale_factor=2); page = ctx.new_page()
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.clock.install(time=time.mktime((2026, 10, 25, 7, 0, 0, 0, 0, -1)))
        # seed old-format data: a check plus a separate fromCheck burn entry
        page.goto('http://localhost:8789/')
        page.fill('#nt-tail', 'N12345'); page.click('text=Add aircraft')
        typ(page, '#s-from', 'KLUK'); typ(page, '#s-to', 'KVBT')
        typ(page, '#s-ete', '329'); typ(page, '#s-fuel', '52.8'); page.click('text=Build plan')
        page.locator('[data-leg-min]').nth(1).fill('80'); page.locator('[data-leg-min]').nth(1).dispatch_event('change'); page.wait_for_timeout(100)
        page.click('text=Start flight'); typ(page, '#sd-at', '3200'); page.click('[data-act=saveStart]'); page.wait_for_timeout(200)
        page.clock.run_for(15*M)
        page.goto('http://localhost:8789/#plan'); page.wait_for_timeout(300)
        legs = lambda: [page.locator(f'.legrow select').nth(i).input_value() for i in range(page.locator('.legrow select').count())]
        print('before:', legs())
        page.locator('[data-act=toggleDone][data-tank=RM]').dispatch_event('click'); page.wait_for_timeout(300)
        print('after:', legs())
        print('chip:', page.locator('[data-act=toggleDone][data-tank=RM]').inner_text(), '|', page.locator('.card:has-text("mark it done for this flight")').inner_text().split('\n')[-1])
        page.screenshot(path=OUT+'/done_plan.png', full_page=True)
        page.goto('http://localhost:8789/#fly'); page.wait_for_timeout(300)
        print('fly gauges:', page.locator('.gauge .nm').all_inner_texts())
        page.locator('.gauge:has-text("RM")').dispatch_event('click'); page.wait_for_timeout(200)
        print('sheet btn:', page.locator('#sheet [data-act=toggleDone]').inner_text())
        page.locator('#sheet [data-act=toggleDone]').dispatch_event('click'); page.wait_for_timeout(300)
        page.goto('http://localhost:8789/#plan'); page.wait_for_timeout(300)
        print('re-enabled:', legs())
        page.goto('http://localhost:8789/#log'); page.wait_for_timeout(200); page.locator('.item').first.dispatch_event('click'); page.wait_for_timeout(300)
        print('log:', [t.split('\n')[0] for t in page.locator('.evrow').all_inner_texts() if 'RM' in t])
        b.close()
finally: srv.terminate()
print('ERRORS', errs)
