import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from common import ROOT, OUT
import subprocess, time, sys
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8767', '--directory', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
errs = []
def typ(page, sel, text):
    page.locator(sel).click(); page.locator(sel).fill('')
    for k in text: page.keyboard.type(k)
try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={'width': 412, 'height': 915}, device_scale_factor=2, timezone_id='America/Chicago')
        page = ctx.new_page()
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
        page.clock.install(time=time.mktime((2026, 10, 23, 13, 0, 0, 0, 0, -1)))
        page.goto('http://localhost:8767/')
        page.fill('#nt-tail', 'N12345'); page.click('text=Add aircraft')
        typ(page, '#s-from', 'KMDD'); typ(page, '#s-to', 'KVBT')
        typ(page, '#s-ete', '226'); typ(page, '#s-fuel', '39'); typ(page, '#s-taxi', '20'); typ(page, '#s-cmin', '12')
        print('calc:', page.inner_text('#setupCalc').replace('\n', ' | '))
        page.screenshot(path=f'{OUT}/c1-setup.png', full_page=True)
        page.click('text=Build plan'); page.wait_for_timeout(200)
        print('leg subs:', [t.replace(chr(10),' | ') for t in page.locator('.legsub').all_inner_texts()[:2]])
        page.screenshot(path=f'{OUT}/c2-plan.png', full_page=True)
        # 1:00 after takeoff, open app
        page.clock.run_for(80 * 60 * 1000)
        page.click('text=Start flight'); typ(page, '#sd-at', '10000')
        print('start preview:', page.inner_text('#sheetPreview').replace('\n', ' | '))
        page.click('[data-act=saveStart]'); page.wait_for_timeout(200)
        print('phase:', page.locator('#flyLive .card').first.inner_text().replace('\n', ' | '))
        page.click('[data-sheet=climb]'); page.wait_for_timeout(100)
        page.screenshot(path=f'{OUT}/c3-climb-sheet.png', full_page=True)
        page.click('[data-act=saveClimb]'); page.wait_for_timeout(200)
        print('phase climbing:', page.locator('#flyLive .card').first.inner_text().replace('\n', ' | '))
        page.screenshot(path=f'{OUT}/c4-fly-climbing.png', full_page=True)
        page.clock.run_for(8 * 60 * 1000)
        page.click('[data-sheet=level]'); page.click('[data-act=saveLevel]'); page.wait_for_timeout(200)
        print('phase after level:', page.locator('#flyLive .card').first.inner_text().replace('\n', ' | '))
        page.goto('http://localhost:8767/#plan'); page.wait_for_timeout(200)
        print('plan subs in flight:', [t.replace(chr(10),' | ') for t in page.locator('.legsub').all_inner_texts()[:3]])
        page.screenshot(path=f'{OUT}/c5-plan-inflight.png', full_page=True)
        b.close()
finally:
    srv.terminate()
print('ERRORS', errs)
