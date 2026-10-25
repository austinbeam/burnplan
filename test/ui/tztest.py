import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from common import ROOT, OUT
import subprocess, time, sys
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8777', '--directory', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errs=[]; M=60000
T0 = 1792782000  # 2026-10-23 19:00Z = 14:00 CDT = 15:00 EDT
try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        c1 = b.new_context(viewport={'width': 412, 'height': 915}, timezone_id='America/Chicago'); page = c1.new_page()
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.clock.install(time=T0)
        page.goto('http://localhost:8777/')
        page.fill('#nt-tail', 'N12345'); page.click('text=Add aircraft')
        page.fill('#s-ete', '2:30'); page.locator('#s-ete').dispatch_event('input'); page.fill('#s-fuel', '40'); page.locator('#s-fuel').dispatch_event('input')
        page.click('text=Build plan'); page.click('text=Start flight')
        page.click('[data-act=sdTmode]'); page.locator('#sd-at').fill('1400'); page.locator('#sd-at').dispatch_event('input')
        print('CT start label:', page.locator('label[for=sd-at]').inner_text(), '|', page.inner_text('#sdAtOther'))
        page.click('[data-act=saveStart]'); page.wait_for_timeout(200)
        print('CT header:', page.locator('.top .kicker').nth(1).inner_text())
        state = c1.storage_state(); c1.close()
        # same data, phone now on Eastern, 1h later
        c2 = b.new_context(viewport={'width': 412, 'height': 915}, timezone_id='America/New_York', storage_state=state); page = c2.new_page()
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.clock.install(time=T0 + 3600)
        page.goto('http://localhost:8777/#fly'); page.wait_for_timeout(300)
        print('ET url/top:', page.url, page.inner_text('#app')[:200].replace(chr(10),' / '), errs)
        print('ET header:', page.locator('.top .kicker').nth(1).inner_text())
        print('ET notice:', page.locator('.card:has([data-ftz])').inner_text().replace('\n',' | ')[:140])
        page.screenshot(path=f'{OUT}/tz1.png')
        # record a switch by clock: 14:45 means 14:45 CDT
        page.click('[data-act=tapTank][data-tank=RM]'); 
        if page.locator('[data-act=sdTmode]').inner_text().startswith('Use clock'): page.click('[data-act=sdTmode]')
        page.locator('#sd-at').fill('1445'); page.locator('#sd-at').dispatch_event('input')
        print('switch clock label:', page.locator('label[for=sd-at]').inner_text(), '| other:', page.inner_text('#sdAtOther'))
        page.click('[data-act=saveSwitch]'); page.wait_for_timeout(300)
        page.goto('http://localhost:8777/#log'); page.wait_for_timeout(200); page.click('.item'); page.wait_for_timeout(200)
        print('log switch:', [t.replace('\n',' / ') for t in page.locator('.evrow.tap').all_inner_texts() if 'Switch' in t])
        # Zulu mode
        page.goto('http://localhost:8777/#aircraft'); page.wait_for_timeout(200); page.click('[data-act=clockMode][data-v=zulu]')
        page.goto('http://localhost:8777/#fly'); page.wait_for_timeout(300)
        print('Zulu header:', page.locator('.top .kicker').nth(1).inner_text(), '| notice shown:', page.locator('[data-ftz]').count())
        b.close()
finally: srv.terminate()
print('ERRORS', errs)
