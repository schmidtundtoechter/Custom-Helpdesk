"""
Buchen API for Custom Helpdesk.

Creates an ERPNext Timesheet from the unlocked, uninvoiced Support Time Log
rows on an HD Ticket. Can be called multiple times per ticket (interim billing).
"""

import frappe
from frappe import _
from frappe.utils import now_datetime


@frappe.whitelist()
def buchen(ticket_name):
    """
    Create an ERPNext Timesheet from all unlocked, uninvoiced time log rows.
    Called from the Buchen button on the HD Ticket form.

    Returns the name of the created Timesheet.
    """
    frappe.has_permission("HD Ticket", "write", ticket_name, throw=True)

    ticket = frappe.get_doc("HD Ticket", ticket_name)
    rows = [
        r for r in (ticket.get("support_time_logs") or [])
        if not r.gesperrt and not r.is_invoiced
    ]

    if not rows:
        frappe.throw(_("Keine buchbaren Zeiteinträge vorhanden."))

    customer_name = _get_erpnext_customer(ticket)
    timesheet = _create_timesheet(ticket, rows, customer_name)

    now = now_datetime()
    for row in rows:
        row.timesheet_ref = timesheet.name
        row.buchen_timestamp = now
        if not row.ruecksprache_erforderlich:
            row.set("gesperrt", 1)

    ticket.flags.ignore_permissions = True
    ticket.save()

    return timesheet.name


def _get_erpnext_customer(ticket):
    """
    Map HD Customer → ERPNext Customer name.
    HD Customer name is the same as ERPNext Customer name (set by customer_sync.py).
    """
    if ticket.customer:
        exists = frappe.db.exists("Customer", ticket.customer)
        return ticket.customer if exists else None
    return None


def _create_timesheet(ticket, rows, customer_name):
    ts = frappe.new_doc("Timesheet")
    ts.customer = customer_name
    ts.note = f"HD Ticket: {ticket.name} — {ticket.subject or ''}"

    if ticket.get("project"):
        ts.project = ticket.project

    for row in rows:
        price_per_hour = 0.0
        time_code = ""
        if row.price_category:
            pc = frappe.db.get_value(
                "Support Price Category",
                row.price_category,
                ["price_per_hour", "time_code", "activity_type"],
                as_dict=True,
            )
            if pc:
                price_per_hour = pc.price_per_hour or 0
                time_code = pc.activity_type or "Support"

        effective = float(row.effective_duration or 0)
        multiplier = int(row.multiplier or 1)
        billed_hours = effective * multiplier

        ts.append("time_logs", {
            "activity_type": time_code or "Support",
            "from_time": row.start_time,
            "to_time": row.end_time,
            "hours": billed_hours,
            "billing_hours": billed_hours,
            "billing_rate": price_per_hour,
            "billing_amount": billed_hours * price_per_hour,
            "is_billable": 1,
            "project": ticket.get("project") or "",
            "description": (
                f"Ticket {ticket.name}"
                + (f" | Rücksprache" if row.ruecksprache_erforderlich else "")
            ),
        })

    ts.flags.ignore_links = True
    ts.insert(ignore_permissions=True)
    return ts


@frappe.whitelist()
def get_buchen_history(ticket_name):
    """
    Return the list of timesheets created for this ticket,
    used to display Buchen history on the ticket form.
    """
    frappe.has_permission("HD Ticket", "read", ticket_name, throw=True)

    rows = frappe.get_all(
        "Support Time Log",
        filters={"parent": ticket_name, "timesheet_ref": ["is", "set"]},
        fields=["timesheet_ref", "buchen_timestamp"],
        order_by="buchen_timestamp asc",
    )

    # Deduplicate by timesheet
    seen = {}
    for r in rows:
        if r.timesheet_ref not in seen:
            seen[r.timesheet_ref] = r.buchen_timestamp

    result = []
    for ts_name, ts_time in seen.items():
        total_hours = frappe.db.get_value(
            "Timesheet", ts_name, "total_hours"
        ) or 0
        result.append({
            "timesheet": ts_name,
            "buchen_timestamp": ts_time,
            "total_hours": total_hours,
        })

    return result
