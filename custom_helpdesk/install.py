"""
Custom Helpdesk install/migrate hooks.
"""
import os
import re

_REGISTER_SW_RE = re.compile(r'<script id="vite-plugin-pwa:register-sw"[^>]*></script>')
_PORTAL_SCRIPT = '<script src="/assets/custom_helpdesk/js/helpdesk_portal.js"></script>'

_JINJA_BOOT = (
    '  <script>\n'
    '    window.site_name = "{{ site_name }}";\n'
    '  </script>\n\n'
    '  <script>\n'
    '    {% for key in boot %}\n'
    '    window["{{ key }}"] = {{ boot[key] | tojson }};\n'
    '    {% endfor %}\n'
    '  </script>\n'
)


def patch_helpdesk_index():
    """
    Rebuild www/helpdesk/index.html from the current Vite output so asset
    hashes are always fresh, the PWA service worker is removed, and the
    custom portal JS is injected.

    Called after every `bench migrate` via after_migrate hook.
    Always overwrites — safe to run multiple times.
    """
    bench_path = os.path.abspath(
        os.path.join(os.path.dirname(__file__), '..', '..', '..')
    )

    vite_path = os.path.join(
        bench_path, 'apps', 'helpdesk', 'helpdesk', 'public', 'desk', 'index.html'
    )
    www_path = os.path.join(
        bench_path, 'apps', 'helpdesk', 'helpdesk', 'www', 'helpdesk', 'index.html'
    )

    if not os.path.exists(vite_path):
        print(f'[custom_helpdesk] WARNING: Vite index not found at {vite_path}')
        return

    with open(vite_path, encoding='utf-8') as f:
        content = f.read()

    # Strip PWA service worker — it scopes to / and breaks ERPNext
    content = _REGISTER_SW_RE.sub('', content)

    if '</body>' not in content:
        print('[custom_helpdesk] WARNING: </body> tag not found — aborting patch.')
        return

    # Inject Jinja boot variables + portal script before </body>
    injection = f'{_JINJA_BOOT}  {_PORTAL_SCRIPT}\n</body>'
    content = content.replace('</body>', injection, 1)

    with open(www_path, 'w', encoding='utf-8') as f:
        f.write(content)

    print('[custom_helpdesk] www/helpdesk/index.html rebuilt from Vite output.')
