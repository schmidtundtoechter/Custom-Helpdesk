"""
Portal API for the Helpdesk Vue SPA.

These whitelisted methods are called by helpdesk_portal.js (injected into the
Helpdesk SPA) to manage Support Time Log rows without needing the ERPNext Desk.
"""

import json

import frappe
from frappe import _
from frappe.utils import now_datetime


@frappe.whitelist()
def get_time_logs(ticket_name):
    """Return all Support Time Log rows for a ticket as a list of dicts."""
    frappe.has_permission("HD Ticket", "read", ticket_name, throw=True)
    ticket = frappe.get_doc("HD Ticket", ticket_name)
    return [row.as_dict() for row in (ticket.support_time_logs or [])]


@frappe.whitelist()
def start_timer(ticket_name):
    """
    Append a new Support Time Log row with start_time = now.
    Returns the new row's name so the JS can reference it.
    """
    frappe.has_permission("HD Ticket", "write", ticket_name, throw=True)

    ticket = frappe.get_doc("HD Ticket", ticket_name)
    row = ticket.append("support_time_logs", {
        "start_time": now_datetime(),
        "entered_by": frappe.session.user,
        "multiplier": "1",
    })
    ticket.flags.ignore_permissions = True
    ticket.save()
    return row.name


@frappe.whitelist()
def stop_timer(ticket_name, row_name):
    """
    Set end_time = now on the given time log row.
    Saving the parent ticket triggers before_save which calculates duration.
    """
    frappe.has_permission("HD Ticket", "write", ticket_name, throw=True)

    ticket = frappe.get_doc("HD Ticket", ticket_name)
    for row in ticket.support_time_logs:
        if row.name == row_name:
            row.end_time = now_datetime()
            break
    else:
        frappe.throw(_("Zeiteintrag nicht gefunden: {0}").format(row_name))

    ticket.flags.ignore_permissions = True
    ticket.save()

    updated = frappe.db.get_value(
        "Support Time Log", row_name,
        ["duration", "effective_duration", "total_cost"],
        as_dict=True,
    )
    return updated


@frappe.whitelist()
def update_time_log(ticket_name, row_name, data):
    """
    Update allowed fields on a Support Time Log row.
    Saves through the parent ticket so all hooks fire correctly.
    """
    frappe.has_permission("HD Ticket", "write", ticket_name, throw=True)

    allowed = {"multiplier", "price_category", "manual_override", "staff_member", "ruecksprache_erforderlich"}
    updates = {k: v for k, v in json.loads(data).items() if k in allowed}
    if not updates:
        return

    ticket = frappe.get_doc("HD Ticket", ticket_name)
    for row in ticket.support_time_logs:
        if row.name == row_name:
            for field, value in updates.items():
                setattr(row, field, value)
            break
    else:
        frappe.throw(_("Zeiteintrag nicht gefunden: {0}").format(row_name))

    ticket.flags.ignore_permissions = True
    ticket.save()

    return frappe.db.get_value(
        "Support Time Log", row_name,
        ["effective_duration", "multiplier", "total_cost", "price_category"],
        as_dict=True,
    )
