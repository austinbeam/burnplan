# Fueling with only the total known ("Total only"): tanks go to target, total compared with the calculated need.
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from common import ROOT, OUT
import subprocess, time, json
from playwright.sync_api import sync_playwright
PORT = '8841'
srv = subprocess.Popen([sys.executable, '-m', 'http.server', PORT, '--directory', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errs = []
S = OUT + '/'
try:
    with sync_playwright() as p:
        b = p.chromium.launch(); page = b.new_page(viewport={'width': 412, 'height': 1600})
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.goto(f'http://localhost:{PORT}/'); page.fill('#nt-tail', 'N12345'); page.click('text=Add aircraft')
        page.click('nav.tabs a:has-text("Fuel")'); page.wait_for_timeout(200)
        page.click('text=Start fueling'); page.wait_for_timeout(200)
        for t, v in {'LT': '4', 'LM': '6', 'RM': '5', 'RT': '17'}.items(): page.fill('#fb-' + t, v)
        page.keyboard.press('Tab'); page.wait_for_timeout(300)
        page.locator('[data-act=fuMode][data-v=total]').dispatch_event('click'); page.wait_for_timeout(200)
        assert page.locator('#fr-0').count() == 0, 'pump steps hidden in total mode'
        page.click('text=Save fueling'); page.wait_for_timeout(200)
        print('empty save toast:', page.locator('.toast').all_inner_texts())
        page.fill('#fu-total', '61'); page.keyboard.press('Tab'); page.wait_for_timeout(300)
        diff = page.locator('[data-totaldiff]').inner_text().replace('\n', ' ')
        print('diff line:', diff); assert '+9.0 gal' in diff, diff
        assert 'never changed' in page.inner_text('#app')
        # one tank known: it gets its own diff, the rest is compared as a group
        page.fill('#fk-LT', '14'); page.keyboard.press('Tab'); page.wait_for_timeout(300)
        rest = page.locator('[data-restdiff]').inner_text().replace('\n', ' ')
        print('rest line:', rest); assert 'LM + RM' in rest and 'RT' not in rest and '+8.0 gal' in rest, rest
        assert '+9.0 gal' in page.locator('[data-totaldiff]').inner_text()
        page.fill('#fk-LM', '60'); page.keyboard.press('Tab'); page.wait_for_timeout(300)
        page.click('text=Save fueling'); page.wait_for_timeout(200)
        assert page.evaluate("JSON.parse(localStorage['burnplan.v1']).fuelDraft") is not None, 'over-total split must not save'
        page.fill('#fk-LM', ''); page.keyboard.press('Tab'); page.wait_for_timeout(300)
        page.screenshot(path=S + 'totalfuel_edit.png', full_page=True)
        page.click('text=Save fueling'); page.wait_for_timeout(300)
        st = json.loads(page.evaluate("localStorage['burnplan.v1']"))
        fu = list(st['fuelings'].values())[0]
        print('saved:', fu['mode'], fu['totalAdded'], fu['steps'], fu['request'])
        assert fu['mode'] == 'total' and fu['totalAdded'] == 61 and fu['steps'] == [] and fu['known'] == {'LT': 14}, fu.get('known')
        detail = page.inner_text('#app'); print('DETAIL:', detail[:600].replace('\n', ' | '))
        assert 'Total only' in detail and '61.0 gal' in detail
        page.screenshot(path=S + 'totalfuel_detail.png', full_page=True)
        # tail cruise burn untouched
        assert not (st['tails']['N12345'].get('overrides') or {}).get('burn', {}).get('cruise'), 'cruise burn must not change'
        page.click('nav.tabs a:has-text("Fuel")'); page.wait_for_timeout(200)
        home = page.inner_text('#app'); print('HOME:', home[:900].replace('\n', ' | '))
        assert 'total only' in home and page.locator('[data-caltotal]').count() == 1
        print('cal total:', page.locator('[data-caltotal]').inner_text().replace('\n', ' '))
        page.click('nav.tabs a:has-text("Plan")'); page.wait_for_timeout(300)
        lv = [page.locator('#lv-' + t).input_value() for t in ['LT', 'LM', 'RM', 'RT']]
        print('setup prefill:', lv); assert [float(x) for x in lv] == [17, 25, 25, 17]
        # edit round trip keeps total mode
        page.click('nav.tabs a:has-text("Fuel")'); page.wait_for_timeout(200)
        page.locator('.list a.item').first.click(); page.wait_for_timeout(200)
        page.click('text=Edit'); page.wait_for_timeout(200)
        print('edit mode on:', page.locator('[data-act=fuMode].on').inner_text(), page.locator('#fu-total').input_value())
        assert page.locator('#fu-total').input_value() == '61' and page.locator('#fk-LT').input_value() == '14'
        b.close()
finally: srv.terminate()
print('ERRORS', errs)
