"""
Address handling for Custom Helpdesk.

When a new Address is created by a portal/customer user (i.e. not a Helpdesk
agent or ERPNext system user), we mark it with `aus_supportvorgang = 1` so
that accounts staff can identify and filter these in ERPNext.

Frappe Address is a shared DocType — the same record appears in both ERPNext
and Helpdesk, so no separate sync is needed.
"""

import frappe


def after_address_insert(doc, method=None):
    """
    Called after_insert on Address.
    If created by a customer/portal user (not an agent), set aus_supportvorgang = 1.
    """
    if frappe.flags.in_patch or frappe.flags.in_install or frappe.flags.in_migrate:
        return

    if doc.get("aus_supportvorgang"):
        return  # already flagged by the caller

    user = frappe.session.user
    if not user or user == "Guest":
        return

    try:
        from helpdesk.utils import is_agent
        if not is_agent(user):
            frappe.db.set_value("Address", doc.name, "aus_supportvorgang", 1)
    except ImportError:
        # Helpdesk not installed — no portal users, nothing to flag
        pass
