"""
Termine API — CRUD for HD Termin records.
Used by helpdesk_portal.js (ticket view) and the calendar web page.
"""

import json
import frappe
from frappe import _


@frappe.whitelist()
def get_termine(ticket_name=None):
    filters = {}
    if ticket_name:
        frappe.has_permission("HD Ticket", "read", ticket_name, throw=True)
        filters["ticket"] = ticket_name
    return frappe.get_all(
        "HD Termin",
        filters=filters,
        fields=["name", "type", "color", "description", "ticket", "from_time", "to_time", "assigned_to"],
        order_by="from_time asc",
    )


@frappe.whitelist()
def add_termin(data):
    d = json.loads(data) if isinstance(data, str) else data
    if not d.get("type"):
        frappe.throw(_("Typ ist erforderlich."))
    if not d.get("from_time"):
        frappe.throw(_("Von-Zeit ist erforderlich."))
    if not d.get("to_time"):
        frappe.throw(_("Bis-Zeit ist erforderlich."))

    termin = frappe.new_doc("HD Termin")
    for field in ("type", "description", "ticket", "from_time", "to_time", "assigned_to"):
        if d.get(field):
            setattr(termin, field, d[field])
    termin.insert(ignore_permissions=True)
    return termin.as_dict()


@frappe.whitelist()
def delete_termin(termin_name):
    frappe.delete_doc("HD Termin", termin_name, ignore_permissions=True)


@frappe.whitelist()
def get_all_termine():
    """Return all HD Termin records for the calendar view."""
    return frappe.get_all(
        "HD Termin",
        fields=["name", "type", "color", "description", "ticket", "from_time", "to_time", "assigned_to"],
        order_by="from_time asc",
        limit=2000,
    )
