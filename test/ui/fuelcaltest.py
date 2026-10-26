import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from common import ROOT, OUT
import subprocess, time, sys
from playwright.sync_api import sync_playwright
# A fueling's calculated before levels follow later edits to the flight before it (here: extending
# a flight that was ended too early), so the "Burn estimate vs the pump" card updates.
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8811', '--directory', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errs=[]; M=60000
try:
    with sync_playwright() as p:
        b = p.chromium.launch(); page = b.new_page(viewport={'width': 412, 'height': 1800})
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.clock.install(time=time.mktime((2026, 10, 23, 13, 0, 0, 0, 0, -1)))
        page.goto('http://localhost:8811/')
        page.fill('#nt-tail', 'N12345'); page.click('text=Add aircraft')
        page.fill('#s-ete', '1:30'); page.locator('#s-ete').dispatch_event('input'); page.fill('#s-fuel', '27'); page.locator('#s-fuel').dispatch_event('input')
        page.click('text=Build plan'); page.click('text=Start flight'); page.locator('#sd-at').fill('0:00'); page.locator('#sd-at').dispatch_event('input'); page.click('[data-act=saveStart]')
        page.clock.run_for(200*M); page.wait_for_timeout(300)
        # ended too early
        page.click('[data-sheet=shutdown]'); page.locator('#sd-at').fill('0:45:00'); page.locator('#sd-at').dispatch_event('input')
        page.click('[data-act=saveShutdown]'); page.wait_for_timeout(300)
        fid = page.evaluate("Object.keys(JSON.parse(localStorage['burnplan.v1']).flights)[0]")
        # top off: pump says 40 gal total
        page.click('nav.tabs a:has-text("Fuel")'); page.wait_for_timeout(200)
        page.click('text=Start fueling'); page.wait_for_timeout(200)
        for i,r in enumerate(['8','20','32','40']): page.fill(f'#fr-{i}', r)
        page.wait_for_timeout(300); page.click('text=Save fueling'); page.wait_for_timeout(300)
        fu = page.evaluate("Object.values(JSON.parse(localStorage['burnplan.v1']).fuelings)[0]")
        print('saved before', fu['before'], 'auto', fu['beforeAuto'])
        assert sorted(fu['beforeAuto']) == ['LM','LT','RM','RT']
        page.click('nav.tabs a:has-text("Fuel")'); page.wait_for_timeout(200)
        c1 = page.inner_text('[data-caltotal]'); print('cal early end:', c1)
        # extend the flight: edit the shutdown 45 min later
        page.goto(f'http://localhost:8811/#log/{fid}'); page.wait_for_timeout(300)
        page.locator('.evrow.tap', has_text='Shutdown').click(); page.locator('#sd-at').fill('1:30:00'); page.locator('#sd-at').dispatch_event('input'); page.click('[data-act=saveEdit]'); page.wait_for_timeout(300)
        page.click('nav.tabs a:has-text("Fuel")'); page.wait_for_timeout(200)
        c2 = page.inner_text('[data-caltotal]'); print('cal after extend:', c2)
        assert c1 != c2, 'calibration did not follow the flight edit'
        assert page.locator('[data-calstale]').count() == 0
        # an older fueling (no beforeAuto) keeps its levels, is flagged, and can be updated in one tap
        page.evaluate("""() => { const s = JSON.parse(localStorage['burnplan.v1']); const x = Object.values(s.fuelings)[0];
          x.before = {LT: 17, LM: 25, RM: 25, RT: 17}; delete x.beforeAuto; s.rev = (s.rev||0)+1; localStorage['burnplan.v1'] = JSON.stringify(s); }""")
        page.reload(); page.wait_for_timeout(400)
        page.click('nav.tabs a:has-text("Fuel")'); page.wait_for_timeout(200)
        print('stale note:', page.inner_text('[data-calstale]'))
        page.locator('[data-calstale] a').first.click(); page.wait_for_timeout(200)
        print('detail:', page.inner_text('[data-stalebefore]').replace(chr(10),' | '))
        page.click('[data-act=fuUseCalc]'); page.wait_for_timeout(300)
        assert page.locator('[data-stalebefore]').count() == 0
        page.click('nav.tabs a:has-text("Fuel")'); page.wait_for_timeout(200)
        c3 = page.inner_text('[data-caltotal]'); print('cal after update:', c3)
        assert c3 == c2 and page.locator('[data-calstale]').count() == 0
        page.screenshot(path=f'{OUT}/fuelcal.png', full_page=True)
        b.close()
finally: srv.terminate()
print('ERRORS', errs)
