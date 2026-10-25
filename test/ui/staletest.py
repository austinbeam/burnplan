import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from common import ROOT, OUT
# Logged events must never be dropped by app logic. A second open copy of the app (another tab, or the
# installed app plus a browser tab) used to hold stale state and overwrite the log the next time it saved,
# e.g. on a settings tap or when a new version loaded. A recorded switch then vanished from the flight.
import subprocess, time, json
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8797', '--directory', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errs = []
URL = 'http://localhost:8797/'
def typ(page, sel, text):
    page.locator(sel).click(); page.locator(sel).fill('')
    for k in text: page.keyboard.type(k)
def switches(page):
    s = json.loads(page.evaluate("localStorage.getItem('burnplan.v1')"))
    f = s['flights'][s['activeFlightId']]
    return sorted((e['tank'], e.get('catchup')) for e in f['events'] if e['type'] == 'switch')
def logged(s):
    f = s['flights'][s['activeFlightId']]
    return [e['type'] + ':' + e.get('tank', '') for e in sorted(f['events'], key=lambda e: e['at'])]
try:
    with sync_playwright() as p:
        b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 412, 'height': 915})
        a = ctx.new_page(); a.on('pageerror', lambda e: errs.append('A: ' + str(e)))
        a.goto(URL)
        a.fill('#nt-tail', 'N12345'); a.click('text=Add aircraft')
        typ(a, '#s-ete', '226'); typ(a, '#s-fuel', '39'); typ(a, '#s-taxi', '20'); typ(a, '#s-cmin', '12')
        a.click('text=Build plan')
        a.click('text=Start flight'); typ(a, '#sd-at', '3000'); a.click('[data-act=saveStart]'); a.wait_for_timeout(300)
        # second copy opens now, while the flight is running
        bp = ctx.new_page(); bp.on('pageerror', lambda e: errs.append('B: ' + str(e)))
        bp.goto(URL + '#fly'); bp.wait_for_timeout(400)
        before = switches(a)
        # pilot records a switch in copy A
        a.goto(URL + '#fly'); a.wait_for_timeout(200)
        a.locator('[data-act=openSheet][data-sheet=switch]').first.dispatch_event('click'); a.wait_for_timeout(150)
        a.locator('.sheet [data-act=sdTank]', has_text='RT').first.click()
        a.click('[data-act=saveSwitch]'); a.wait_for_timeout(300)
        after_a = switches(a)
        print('switches before:', before, '| after recording in A:', after_a)
        # copy B (opened before the switch) saves something unrelated: the Fly clock/timer toggle
        bp.bring_to_front(); bp.wait_for_timeout(200)
        bp.locator('[data-act=toggleFlyMode]').first.dispatch_event('click'); bp.wait_for_timeout(300)
        after_b = switches(a)
        print('after copy B saved:', after_b)
        if len(after_b) != len(after_a): errs.append(f'logged switch dropped by stale copy: {after_a} -> {after_b}')
        # copy B still renders after picking up A's write (storage event)
        bp.goto(URL + '#log'); bp.wait_for_timeout(300)
        s = json.loads(a.evaluate("localStorage.getItem('burnplan.v1')"))
        print('log now:', logged(s))
        b.close()
finally:
    srv.terminate()
print('ERRORS', errs)
