"""
Custom Helpdesk install/migrate hooks.
"""
import os

SCRIPT_TAG = '<script src="/assets/custom_helpdesk/js/helpdesk_portal.js"></script>'
INJECT_BEFORE = '</body>'


def patch_helpdesk_index():
    """
    Inject custom_helpdesk portal JS into the Helpdesk's www/helpdesk/index.html.

    Called automatically after every `bench migrate` via the after_migrate hook.
    Also run manually after `bench build --app helpdesk` (that command can update
    the asset hash in index.html, which leaves our tag intact but is worth checking).

    Idempotent — does nothing if the tag is already present.
    """
    bench_path = os.path.abspath(
        os.path.join(os.path.dirname(__file__), '..', '..', '..')
    )
    index_path = os.path.join(
        bench_path, 'apps', 'helpdesk', 'helpdesk', 'www', 'helpdesk', 'index.html'
    )

    if not os.path.exists(index_path):
        print(f'[custom_helpdesk] WARNING: Helpdesk index.html not found at {index_path}')
        return

    with open(index_path, 'r', encoding='utf-8') as f:
        content = f.read()

    if SCRIPT_TAG in content:
        print('[custom_helpdesk] Helpdesk index.html already patched — skipping.')
        return

    if INJECT_BEFORE not in content:
        print('[custom_helpdesk] WARNING: </body> not found in Helpdesk index.html — cannot patch.')
        return

    content = content.replace(INJECT_BEFORE, f'  {SCRIPT_TAG}\n  {INJECT_BEFORE}', 1)

    with open(index_path, 'w', encoding='utf-8') as f:
        f.write(content)

    print('[custom_helpdesk] Patched Helpdesk index.html with portal JS script tag.')
