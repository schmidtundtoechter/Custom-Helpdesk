"""
Sync ERPNext Customer → Frappe Helpdesk HD Customer.

When an ERPNext Customer is created or updated, we create or update the
matching HD Customer so that tickets can be assigned to the correct customer
in Helpdesk.

HD Customer uses a `domain` field for email-based auto-routing of tickets.
This domain is configured via the `helpdesk_domain` custom field on the
ERPNext Customer record.
"""

import frappe


def sync_to_hd_customer(doc, method=None):
    """
    Called after_insert and after_save on ERPNext Customer.
    Creates or updates the matching HD Customer.
    """
    if frappe.flags.in_patch or frappe.flags.in_install or frappe.flags.in_migrate:
        return

    # Avoid recursion: don't re-trigger if we're already inside a sync
    if frappe.flags.custom_helpdesk_syncing:
        return

    try:
        frappe.flags.custom_helpdesk_syncing = True
        _sync(doc)
    finally:
        frappe.flags.custom_helpdesk_syncing = False


def _sync(erp_customer):
    hd_customer_name = erp_customer.name  # HD Customer uses customer name as key

    domain = erp_customer.get("helpdesk_domain") or ""

    if frappe.db.exists("HD Customer", hd_customer_name):
        hd = frappe.get_doc("HD Customer", hd_customer_name)
        changed = False
        if hd.customer_name != erp_customer.customer_name:
            hd.customer_name = erp_customer.customer_name
            changed = True
        if domain and hd.domain != domain:
            hd.domain = domain
            changed = True
        if changed:
            hd.save(ignore_permissions=True)
    else:
        hd = frappe.new_doc("HD Customer")
        hd.customer_name = erp_customer.customer_name
        hd.domain = domain
        # Use the ERPNext Customer name as the HD Customer name for traceability
        hd.flags.name = hd_customer_name
        hd.insert(ignore_permissions=True)
