import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from common import ROOT, OUT
import subprocess, time, sys, json
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8790', '--directory', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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
        page.goto('http://localhost:8790/')
        page.fill('#nt-tail', 'N12345'); page.click('text=Add aircraft')
        typ(page, '#s-from', 'KLUK'); typ(page, '#s-to', 'KVBT')
        typ(page, '#s-ete', '329'); typ(page, '#s-fuel', '52.8'); page.click('text=Build plan')
        page.locator('[data-leg-min]').nth(1).fill('80'); page.locator('[data-leg-min]').nth(1).dispatch_event('change'); page.wait_for_timeout(100)
        print('plan note (default):', page.locator('text=Times are your flight timer').inner_text())
        page.goto('http://localhost:8790/#aircraft'); page.wait_for_timeout(200)
        page.locator('[data-act=setTimerFrom][data-v=engine]').dispatch_event('click'); page.wait_for_timeout(200)
        page.goto('http://localhost:8790/#plan'); page.wait_for_timeout(300)
        print('plan note (engine):', page.locator('text=Times are your flight timer').inner_text())
        print('axis:', page.locator('.axis').first.inner_text().replace('\n',' '))
        print('first rows start:', page.locator('.legrow:not(.head)').nth(0).inner_text().split('\n')[:4])
        page.click('text=Start flight'); typ(page, '#sd-at', '3000'); page.wait_for_timeout(200)
        print('preview:', page.inner_text('#sheetPreview').replace('\n',' | '))
        page.click('[data-act=saveStart]'); page.wait_for_timeout(300)
        st = page.evaluate("(() => { const s = JSON.parse(localStorage['burnplan.v1']); const f = Object.values(s.flights)[0]; return {timerFrom: f.timerFrom, toAgoMin: (Date.now() - f.takeoff)/60000, esAgoMin: (Date.now()-f.engineStart)/60000}; })()")
        print('state:', st)
        print('elapsed:', page.inner_text('#elapsed'))
        page.goto('http://localhost:8790/#log'); page.wait_for_timeout(200); page.locator('.item').first.dispatch_event('click'); page.wait_for_timeout(300)
        print('log:', [t.replace('\n',' ') for t in page.locator('.evrow').all_inner_texts()[:4]])
        b.close()
finally: srv.terminate()
print('ERRORS', errs)
