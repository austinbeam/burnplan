import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from common import ROOT, OUT
# Changing the tank floor in the tail's settings during a flight applies it to that flight's config without
# creating a plan version (the old plan is flagged against it); Rebuild / Regenerate then plans to the new floor.
import subprocess, time, json
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8811', '--directory', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errs=[]; M=60000
def typ(page, sel, text):
    page.locator(sel).click(); page.locator(sel).fill('')
    for k in text: page.keyboard.type(k)
def flight(page):
    s = json.loads(page.evaluate("localStorage.getItem('burnplan.v1')"))
    return s['flights'][s['activeFlightId']]
def set_floor(page, v):
    page.goto('http://localhost:8811/#aircraft/N12345'); page.wait_for_timeout(300)
    page.fill('[data-ovr="rules.floor.gal"]', v); page.locator('[data-ovr="rules.floor.gal"]').dispatch_event('change'); page.wait_for_timeout(300)
def rebuild(page):
    page.goto('http://localhost:8811/#plan'); page.wait_for_timeout(300)
    page.locator('.btn[data-act=regen]').last.dispatch_event('click'); page.wait_for_timeout(300)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 412, 'height': 915}, device_scale_factor=2); page = ctx.new_page()
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.clock.install(time=time.mktime((2026, 10, 25, 7, 0, 0, 0, 0, -1)))
        page.goto('http://localhost:8811/')
        page.fill('#nt-tail', 'N12345'); page.click('text=Add aircraft')
        typ(page, '#s-from', 'KAAA'); typ(page, '#s-to', 'KBBB')
        typ(page, '#s-ete', '400'); typ(page, '#s-fuel', '70'); page.click('text=Build plan')
        # Draft: floor applies to the flight, plan untouched until Regenerate.
        set_floor(page, '6'); f = flight(page)
        print('draft floor:', f['cfg']['rules']['floor']['gal'], '| versions:', len(f['planHistory']), '|', f['plan']['reason'])
        assert f['cfg']['rules']['floor']['gal'] == 6 and len(f['planHistory']) == 0
        rebuild(page); f = flight(page); print('regenerated:', f['plan']['reason'], len(f['planHistory']))
        assert len(f['planHistory']) == 1
        page.click('text=Start flight'); typ(page, '#sd-at', '000'); page.click('[data-act=saveStart]'); page.wait_for_timeout(200)
        page.clock.run_for(40*M)
        f = flight(page); n0 = len(f['planHistory']); ev0 = json.dumps(f['events']); plan0 = json.dumps(f['plan'])
        set_floor(page, '10'); f = flight(page)
        print('active floor:', f['cfg']['rules']['floor']['gal'], '| new versions:', len(f['planHistory']) - n0)
        assert f['cfg']['rules']['floor']['gal'] == 10, 'floor not applied to active flight'
        assert len(f['planHistory']) == n0 and json.dumps(f['plan']) == plan0, 'floor change must not create a plan version'
        assert json.dumps(f['events']) == ev0, 'actual events changed'
        page.goto('http://localhost:8811/#plan'); page.wait_for_timeout(300)
        body = page.locator('body').inner_text()
        print('old plan flagged:', 'below 10 gal floor' in body)
        assert 'below 10 gal floor' in body
        rebuild(page); f = flight(page)
        print('rebuilt:', [(l['tank'], round(l['min'])) for l in f['plan']['legs']], '|', f['plan']['reason'], '| versions +', len(f['planHistory']) - n0)
        assert len(f['planHistory']) == n0 + 1 and json.dumps(f['events']) == ev0
        body = page.locator('body').inner_text()
        print('rebuilt plan flagged:', 'below 10 gal floor' in body)
        assert 'below 10 gal floor' not in body, 'rebuild ignores the new floor'
        page.screenshot(path=OUT+'/floor_plan.png', full_page=True)
        # Cleared override goes back to the type's default floor.
        set_floor(page, ''); f = flight(page); print('cleared:', f['cfg']['rules']['floor']['gal'])
        assert f['cfg']['rules']['floor']['gal'] == 4
        b.close()
finally: srv.terminate()
print('ERRORS', errs)
