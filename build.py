b=open('body.html').read()
css=open('style.css').read()
js=open('core.js').read().replace("if (typeof module !== 'undefined') {","if (typeof module !== 'undefined' && module.exports !== undefined) {")+"\n"+open('app.js').read()
assert '</script' not in js
import os, json
art = {}
if os.path.isdir('art'):
    for fn in sorted(os.listdir('art')):
        stem, ext = os.path.splitext(fn)
        if ext.lower() in ('.webp', '.png', '.jpg', '.jpeg', '.svg') and not fn.startswith('.'):
            art[stem] = 'art/' + fn
assert js.count('const ART = {};') == 1
js = js.replace('const ART = {};', 'const ART = ' + json.dumps(art, ensure_ascii=False) + ';')
out=b.replace('@@CSS@@',css).replace('@@JS@@',js)
print('art slots:', len(art))
open('index.html','w').write(out)
print(len(out))
