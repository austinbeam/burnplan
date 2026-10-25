import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from common import ROOT, OUT
import subprocess, time, sys
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8774', '--directory', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errs=[]
M = 60*1000
def total(page): return page.inner_text('.sides .tot .v')
def alert(page): return page.inner_text('#alertbar').replace('\n',' | ') if page.locator('#alertbar .inner').count() else 'none'
def setup(page, ete='226', fuel='39', start='000'):
    page.fill('#nt-tail', 'N12345'); page.click('text=Add aircraft')
    page.fill('#s-ete', ete); page.locator('#s-ete').dispatch_event('input'); page.fill('#s-fuel', fuel); page.locator('#s-fuel').dispatch_event('input')
    page.click('text=Build plan'); page.click('text=Start flight')
    page.locator('#sd-at').fill(start); page.locator('#sd-at').dispatch_event('input'); page.click('[data-act=saveStart]'); page.wait_for_timeout(200)
try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        # --- A/B: landing alert, freeze, still flying, shutdown default
        ctx = b.new_context(viewport={'width': 412, 'height': 915}, device_scale_factor=2, timezone_id='America/Chicago'); page = ctx.new_page()
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.clock.install(time=time.mktime((2026, 10, 23, 13, 0, 0, 0, 0, -1)))
        page.goto('http://localhost:8774/'); setup(page)
        # follow the plan: record each planned switch on time
        page.clock.run_for(146*M + 30*1000)   # takeoff +2:26 = arrival
        page.wait_for_timeout(300)
        print('at arrival alert:', alert(page))
        page.click('[data-act=alertDismiss]')
        page.clock.run_for(16*M); page.wait_for_timeout(300)
        print('after grace alert:', alert(page)); t1 = total(page)
        page.screenshot(path=f'{OUT}/l1-landed.png', full_page=True)
        page.clock.run_for(60*M); page.wait_for_timeout(300)
        print('frozen total stays:', t1, '->', total(page))
        page.click('#alertbar [data-act=stillFlying]'); page.wait_for_timeout(200)
        print('still flying opens:', page.locator('.sheet h2').inner_text()); page.click('[data-act=closeSheet]'); page.wait_for_timeout(200)
        print('resumed total:', total(page))
        page.clock.run_for(16*M); page.wait_for_timeout(300)
        print('re-frozen after snooze:', alert(page)[:60])
        page.click('#alertbar [data-act=alertShutdown]'); page.wait_for_timeout(100)
        print('shutdown default time:', page.input_value('#sd-at'))
        ctx.close()
        # --- C: empty tank (missed switch)
        ctx = b.new_context(viewport={'width': 412, 'height': 915}, device_scale_factor=2, timezone_id='America/Chicago'); page = ctx.new_page()
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.clock.install(time=time.mktime((2026, 10, 23, 13, 0, 0, 0, 0, -1)))
        page.goto('http://localhost:8774/'); setup(page, ete='433', fuel='70.9')
        page.clock.run_for(110*M); page.wait_for_timeout(300)
        print('empty alert:', alert(page))
        print('LM gauge:', page.locator('[data-tank=LM] .g').inner_text())
        page.screenshot(path=f'{OUT}/l2-empty.png', full_page=True)
        page.click('#alertbar [data-act=emptySwitch]'); page.wait_for_timeout(100)
        print('switch sheet at:', page.input_value('#sd-at'))
        page.click('.tankpick button:has-text("RM")'); page.click('[data-act=saveSwitch]'); page.wait_for_timeout(300)
        print('after switch: LM', page.locator('[data-tank=LM] .g').inner_text(), 'RM', page.locator('[data-tank=RM] .g').inner_text(), '| card:', page.locator('#flyLive .issue').count())
        ctx.close()
        # --- D: auto-end on reopen hours later
        ctx = b.new_context(viewport={'width': 412, 'height': 915}, device_scale_factor=2, timezone_id='America/Chicago'); page = ctx.new_page()
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.clock.install(time=time.mktime((2026, 10, 23, 13, 0, 0, 0, 0, -1)))
        page.goto('http://localhost:8774/'); setup(page)
        page.clock.run_for(6*60*M); page.wait_for_timeout(400)
        print('auto-end toast:', page.inner_text('#toast'), '| url:', page.url)
        page.goto('http://localhost:8774/#log'); page.wait_for_timeout(200); page.click('.item'); page.wait_for_timeout(200)
        print('log notice:', page.locator('.issue').first.inner_text()[:110])
        print('events:', [t.split('\n')[0] for t in page.locator('.evrow.tap').all_inner_texts()])
        page.screenshot(path=f'{OUT}/l3-log.png', full_page=True)
        b.close()
finally: srv.terminate()
print('ERRORS', errs)
