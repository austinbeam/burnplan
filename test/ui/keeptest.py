import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from common import ROOT, OUT
import subprocess, time, sys
from playwright.sync_api import sync_playwright
# Plan page: type a target level ("After") to set a leg's minutes, then keep legs through one and rebuild the rest.
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8797', '--directory', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errs=[]
def typ(page, sel, text):
    page.locator(sel).click(); page.locator(sel).fill('')
    for k in text: page.keyboard.type(k)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 412, 'height': 915}, device_scale_factor=2); page = ctx.new_page()
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.clock.install(time=time.mktime((2026, 10, 25, 7, 0, 0, 0, 0, -1)))
        page.goto('http://localhost:8797/')
        page.fill('#nt-tail', 'N12345'); page.click('text=Add aircraft')
        typ(page, '#s-from', 'KAAA'); typ(page, '#s-to', 'KBBB')
        typ(page, '#s-ete', '300'); typ(page, '#s-fuel', '70'); page.click('text=Build plan'); page.wait_for_timeout(200)
        rows = lambda: [(page.locator('.legrow select').nth(i).input_value(), page.locator('[data-leg-min]').nth(i).input_value(), page.locator('[data-leg-after]').nth(i).input_value()) for i in range(page.locator('.legrow select').count())]
        print('generated:', rows())
        a = page.locator('[data-leg-after]').nth(0); a.fill('15'); a.dispatch_event('change'); page.wait_for_timeout(200)
        r = rows(); print('leg 1 to 15 gal:', r)
        assert r[0][2] == '15.0', r[0]
        n = page.locator('.legrow select').count()
        page.locator('[data-act=keepLeg]').nth(0).dispatch_event('click'); page.wait_for_timeout(200)
        print('sheet:', page.locator('#sheet h2').inner_text())
        page.locator('#sheet [data-act=confirmYes]').dispatch_event('click'); page.wait_for_timeout(300)
        r2 = rows(); print('kept 1, rebuilt:', r2)
        assert r2[0] == r[0], (r2[0], r[0])
        assert r2[1][0] == 'RM', r2[1]
        print('issues:', page.locator('.issue').all_inner_texts())
        print('badge:', page.locator('.badge').first.inner_text())
        bad = page.locator('[data-leg-after]').nth(1); bad.fill('99'); bad.dispatch_event('change'); page.wait_for_timeout(200)
        print('too high ->', page.locator('.toast').inner_text() if page.locator('.toast').count() else 'no toast', rows()[1])
        page.screenshot(path=OUT+'/keep_plan.png', full_page=True)
        # Hard rule: plan changes never move a logged event's time.
        page.click('text=Start flight'); typ(page, '#sd-at', '3200'); page.click('[data-act=saveStart]'); page.wait_for_timeout(200)
        page.clock.run_for(20*60000)
        page.goto('http://localhost:8797/#fly'); page.wait_for_timeout(300)
        page.locator('.gauge:has-text("RM")').dispatch_event('click'); page.wait_for_timeout(200)
        sw = page.locator('#sheet [data-act=saveSwitch], #sheet button:has-text("Switch")')
        if sw.count(): sw.first.dispatch_event('click'); page.wait_for_timeout(200)
        evs = lambda: page.evaluate("() => { const s = JSON.parse(localStorage.getItem('burnplan.v1')); const f = Object.values(s.flights).find((x) => x.status === 'active'); return f.events.filter((e) => !['park', 'unpark'].includes(e.type)).map((e) => [e.type, e.tank || '', e.at, e.until || 0]); }")
        before = evs(); print('events:', [e[:2] for e in before])
        page.goto('http://localhost:8797/#plan'); page.wait_for_timeout(300)
        page.locator('button[data-act=regen]').last.dispatch_event('click'); page.wait_for_timeout(200)
        a = page.locator('[data-leg-after]').nth(0); a.fill(str(float(a.input_value()) + 1)); a.dispatch_event('change'); page.wait_for_timeout(200)
        page.locator('[data-act=keepLeg]').nth(0).dispatch_event('click'); page.wait_for_timeout(200)
        page.locator('#sheet [data-act=confirmYes]').dispatch_event('click'); page.wait_for_timeout(200)
        m = page.locator('[data-leg-min]').nth(1); m.fill('7'); m.dispatch_event('change'); page.wait_for_timeout(200)
        page.locator('[data-act=delLeg]').last.dispatch_event('click'); page.wait_for_timeout(200)
        page.locator('[data-act=toggleDone][data-tank=LT]').dispatch_event('click'); page.wait_for_timeout(200)
        after = evs()
        assert after == before, (before, after)
        print('event times unchanged after rebuild, target edit, keep, minutes edit, delete, done:', len(after))
        b.close()
finally: srv.terminate()
print('ERRORS', errs)
