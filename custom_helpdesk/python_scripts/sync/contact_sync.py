"""
Contact handling for Custom Helpdesk.

Frappe Contact is a shared DocType used by both ERPNext and Helpdesk.
When a new contact is created by a portal/customer user (i.e. not a Helpdesk
agent or ERPNext system user), we mark it with `supportkontakt = 1` and
`aus_supportvorgang = 1` so accounts staff can filter it in ERPNext.

Note: Helpdesk already has its own before_insert hook on Contact that
auto-links the contact to an HD Customer by email domain. We don't
interfere with that — we only add our own marking logic.
"""

import frappe


def after_contact_insert(doc, method=None):
    """
    Called after_insert on Contact.
    If the contact was created by a portal/customer user (not an agent),
    mark it with supportkontakt = 1 and aus_supportvorgang = 1.
    """
    if frappe.flags.in_patch or frappe.flags.in_install or frappe.flags.in_migrate:
        return

    if doc.get("supportkontakt") and doc.get("aus_supportvorgang"):
        return  # already flagged by the caller

    user = frappe.session.user
    if not user or user == "Guest":
        return

    try:
        from helpdesk.utils import is_agent
        if not is_agent(user):
            updates = {}
            if not doc.get("supportkontakt"):
                updates["supportkontakt"] = 1
            if not doc.get("aus_supportvorgang"):
                updates["aus_supportvorgang"] = 1
            if updates:
                frappe.db.set_value("Contact", doc.name, updates)
    except ImportError:
        # Helpdesk not installed — no portal users, nothing to flag
        pass
