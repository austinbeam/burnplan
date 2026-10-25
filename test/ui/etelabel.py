import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from common import ROOT, OUT
import subprocess, time, sys
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8791', '--directory', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errs=[]
def typ(page, sel, text):
    page.locator(sel).click(); page.locator(sel).fill('')
    for k in text: page.keyboard.type(k)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(); page = b.new_page(viewport={'width': 412, 'height': 915})
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.goto('http://localhost:8791/')
        page.fill('#nt-tail', 'N12345'); page.click('text=Add aircraft')
        typ(page, '#s-ete', '329'); typ(page, '#s-fuel', '52.8'); page.click('text=Build plan'); page.click('text=Start flight')
        typ(page, '#sd-at', '13000'); page.click('[data-act=saveStart]'); page.wait_for_timeout(200)
        page.click('[data-sheet=ete]'); page.wait_for_timeout(100)
        print('label:', page.locator('label[for=sd-gph]').inner_text(), '| placeholder:', page.get_attribute('#sd-gph', 'placeholder'))
        pe, pf = page.get_attribute('#sd-ete', 'placeholder'), page.get_attribute('#sd-fuel', 'placeholder')
        print('ete placeholder:', pe, '| fuel placeholder:', pf, '| blank preview:', page.inner_text('#sheetPreview').replace('\n',' | ')[:200])
        assert pe and pe != '2:58' and pf and pf != '45.1', (pe, pf)
        bx = [page.locator(s).bounding_box() for s in ('#sd-ete', '#sd-fuel')]
        print('input tops:', round(bx[0]['y']), round(bx[1]['y'])); assert abs(bx[0]['y'] - bx[1]['y']) < 2
        page.screenshot(path=f'{OUT}/etesheet.png')
        typ(page, '#sd-ete', '200'); print('preview:', page.inner_text('#sheetPreview').replace('\n',' | ')[:160])
        page.locator('#sd-ete').fill(''); page.locator('[data-act=saveEte]').dispatch_event('click'); page.wait_for_timeout(300)
        print('blank ETE saved:', page.inner_text('#toast') if page.locator('#toast').count() else '')
        b.close()
finally: srv.terminate()
print('ERRORS', errs)
