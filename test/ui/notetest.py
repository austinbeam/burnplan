import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from common import ROOT, OUT
import subprocess, time, sys, json
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8788', '--directory', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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
        page.goto('http://localhost:8788/')
        page.fill('#nt-tail', 'N12345'); page.click('text=Add aircraft')
        typ(page, '#s-from', 'KLUK'); typ(page, '#s-to', 'KVBT')
        typ(page, '#s-ete', '329'); typ(page, '#s-fuel', '52.8'); page.click('text=Build plan')
        page.locator('[data-leg-min]').nth(1).fill('80'); page.locator('[data-leg-min]').nth(1).dispatch_event('change'); page.wait_for_timeout(100)
        page.click('text=Start flight'); typ(page, '#sd-at', '3200'); page.click('[data-act=saveStart]'); page.wait_for_timeout(200)
        page.clock.run_for(15*M)
        page.click('[data-sheet=check]'); typ(page, '#sd-used', '14.3'); typ(page, '#sd-gph', '13.4'); page.click('[data-act=saveCheck]'); page.wait_for_timeout(400)
        page.click('[data-sheet=ete]'); typ(page, '#sd-ete', '248'); typ(page, '#sd-fuel', '38'); page.click('[data-act=saveEte]'); page.wait_for_timeout(400)
        # inject a legacy duplicate burn to test the migration
        page.evaluate("""() => { const s = JSON.parse(localStorage.getItem('burnplan.v1')); const f = Object.values(s.flights)[0];
          const c = f.events.find(e => e.type === 'check'); c.setsBurn = false; f.events.push({type:'burn', at:c.at, gph:13.4, fromCheck:true}); localStorage.setItem('burnplan.v1', JSON.stringify(s)); }""")
        page.reload(); page.wait_for_timeout(300)
        page.goto('http://localhost:8788/#log'); page.wait_for_timeout(200); page.click('.item'); page.wait_for_timeout(300)
        print('events:', [t.split('\n')[0] for t in page.locator('.evrow.tap').all_inner_texts()])
        page.click('details.card summary:has-text("Plan versions")'); page.wait_for_timeout(100)
        page.click('text=+ Note'); page.wait_for_timeout(200)
        page.fill('#sd-note', 'Light chop at 9500, rich of peak'); page.click('[data-act=saveEdit]'); page.wait_for_timeout(300)
        print('note rows:', page.locator('.evrow.note').all_inner_texts())
        page.click('.evrow.note'); page.wait_for_timeout(200)
        page.fill('#sd-note', 'Edited note'); page.click('[data-act=saveEdit]'); page.wait_for_timeout(300)
        print('edited:', page.locator('.evrow.note').all_inner_texts())
        page.screenshot(path=OUT+'/note.png', full_page=True)
        # planned (unstarted) flight also gets a note
        page.goto('http://localhost:8788/#plan'); page.wait_for_timeout(200)
        b.close()
finally: srv.terminate()
print('ERRORS', errs)
