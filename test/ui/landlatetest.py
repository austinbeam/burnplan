import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from common import ROOT, OUT
import subprocess, time, sys
from playwright.sync_api import sync_playwright
# Landed tapped late (after taxi-in): the sheet starts at the expected landing, not now.
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8796', '--directory', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errs=[]; M=60000
def click(page, sel): page.locator(sel).first.dispatch_event('click'); page.wait_for_timeout(200)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(); page = b.new_page(viewport={'width': 412, 'height': 1400})
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.clock.install(time=time.mktime((2026, 10, 25, 9, 0, 0, 0, 0, -1)))
        page.goto('http://localhost:8796/')
        page.fill('#nt-tail', 'N12345'); page.click('text=Add aircraft')
        page.fill('#s-ete', '1:00'); page.locator('#s-ete').dispatch_event('input'); page.fill('#s-fuel', '30'); page.locator('#s-fuel').dispatch_event('input')
        page.click('text=Build plan'); page.wait_for_timeout(300)
        page.click('text=Start flight'); page.locator('#sd-at').fill('0:00:00'); page.locator('#sd-at').dispatch_event('input'); click(page, '[data-act=saveStart]')
        page.goto('http://localhost:8796/#fly'); page.wait_for_timeout(300)
        page.clock.run_for(30*M); page.wait_for_timeout(300)
        click(page, '[data-sheet=ete]'); page.locator('#sd-ete').fill('0:40'); page.locator('#sd-ete').dispatch_event('input'); click(page, '[data-act=saveEte]')
        page.clock.run_for(30*M); page.wait_for_timeout(300)    # +1:00 start down
        click(page, '[data-sheet=descent]'); page.fill('#sd-dgph', '9'); click(page, '[data-act=saveDescent]')
        page.clock.run_for(20*M); page.wait_for_timeout(1200)   # landed at +1:10, now +1:20
        click(page, '[data-sheet=landed]')
        at = page.input_value('#sd-at'); print('landed prefill:', at)
        assert at.startswith('1:10'), at
        print('expected button:', page.locator('#sheet [data-act=sdAtMs]').inner_text())
        page.screenshot(path=OUT+'/landlate.png')
        click(page, '[data-act=saveLanded]')
        st = page.evaluate("(() => { const s = JSON.parse(localStorage['burnplan.v1']); const f = Object.values(s.flights)[0]; const l = f.events.find(e => e.type === 'landing'); return Math.round((l.at - f.takeoff) / 60000); })()")
        print('landing minutes after takeoff:', st); assert st == 70, st
        b.close()
finally: srv.terminate()
print('ERRORS', errs)
