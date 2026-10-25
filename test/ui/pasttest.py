import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from common import ROOT, OUT
import subprocess, time, sys, re
from playwright.sync_api import sync_playwright
# Viewing a past moment on Fly: the switch card counts from that moment, not from real time.
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8791', '--directory', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errs=[]; M=60000
try:
    with sync_playwright() as p:
        b = p.chromium.launch(); page = b.new_page(viewport={'width': 412, 'height': 915}, device_scale_factor=2)
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.clock.install(time=time.mktime((2026, 10, 23, 13, 0, 0, 0, 0, -1)))
        page.goto('http://localhost:8791/')
        page.fill('#nt-tail', 'N12345'); page.click('text=Add aircraft')
        page.fill('#s-ete', '4:33'); page.locator('#s-ete').dispatch_event('input'); page.fill('#s-fuel', '70.9'); page.locator('#s-fuel').dispatch_event('input')
        page.click('text=Build plan'); page.click('text=Start flight'); page.locator('#sd-at').fill('0:30'); page.locator('#sd-at').dispatch_event('input'); page.click('[data-act=saveStart]'); page.wait_for_timeout(200)
        nxt = page.locator('#flyLive .card', has_text='Next planned switch').inner_text()
        mm = re.search(r'in (\d+):(\d+)', nxt); mins = int(mm.group(1))*60 + int(mm.group(2))
        page.clock.run_for((mins + 2) * M); page.wait_for_timeout(200)
        page.click('[data-act=alertDismiss]') if page.locator('[data-act=alertDismiss]').count() else None
        live = page.locator('#flyLive .card', has_text=re.compile('plan(ned)? (says )?switch', re.I)).first.inner_text().replace('\n', ' | ')
        print('live card:', live)
        page.fill('#flyTime', '0:20:00'); page.locator('#flyTime').dispatch_event('change'); page.locator('#flyTime').blur()
        page.clock.run_for(3000); page.wait_for_timeout(200)
        card = page.locator('#flyLive .card', has_text=re.compile('plan(ned)? (says )?switch', re.I)).first.inner_text().replace('\n', ' | ')
        print('viewing +0:20 card:', card)
        assert 'At +0:20' in card and 'after +0:20' in card and 'late' not in card, card
        page.screenshot(path=f'{OUT}/past1.png')
        page.click('[data-act=liveTime]'); page.wait_for_timeout(200)
        card = page.locator('#flyLive .card', has_text=re.compile('plan(ned)? (says )?switch', re.I)).first.inner_text().replace('\n', ' | ')
        print('back live card:', card)
        assert 'At +' not in card and 'late' in card, card
        planned = re.search(r'(\+\d:\d\d:\d\d)', card).group(1)
        # record the late switch (rebuilds the plan), fly on, then look back: the card uses the plan in force then
        page.locator('#flyLive [data-act=openSheet][data-sheet=switch]').dispatch_event('click'); page.wait_for_timeout(200)
        page.locator('[data-act=saveSwitch]').dispatch_event('click'); page.wait_for_timeout(200)
        page.clock.run_for(20 * M); page.wait_for_timeout(200)
        page.click('[data-act=alertDismiss]') if page.locator('[data-act=alertDismiss]').count() else None
        page.fill('#flyTime', '0:20:00'); page.locator('#flyTime').dispatch_event('change'); page.locator('#flyTime').blur()
        page.clock.run_for(3000); page.wait_for_timeout(200)
        card = page.locator('#flyLive .card', has_text=re.compile('plan(ned)? (says )?switch', re.I)).first.inner_text().replace('\n', ' | ')
        print('after rebuild, viewing +0:20:', card, '| plan said', planned)
        assert planned in card and 'Actually switched to RM' in card, card
        page.screenshot(path=f'{OUT}/past2.png')
        b.close()
finally: srv.terminate()
print('ERRORS', errs)
