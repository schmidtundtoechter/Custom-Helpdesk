"""
Buchen API for Custom Helpdesk.

Creates an ERPNext Timesheet from the unlocked, uninvoiced Support Time Log
rows on an HD Ticket. Can be called multiple times per ticket (interim billing).
"""

import frappe
from frappe import _
from frappe.utils import now_datetime, flt, cint


@frappe.whitelist()
def buchen(ticket_name, row_names=None):
    """
    Create an ERPNext Timesheet from selected (or all) unlocked, uninvoiced time log rows.
    row_names: optional JSON list of row names to book; if omitted all bookable rows are used.
    Returns the name of the created Timesheet.
    """
    import json as _json
    frappe.has_permission("HD Ticket", "write", ticket_name, throw=True)

    selected = None
    if row_names:
        selected = set(_json.loads(row_names) if isinstance(row_names, str) else row_names)

    ticket = frappe.get_doc("HD Ticket", ticket_name)
    rows = [
        r for r in (ticket.get("support_time_logs") or [])
        if not r.gesperrt and not r.is_invoiced and not r.timesheet_ref
        and (selected is None or r.name in selected)
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

    for item_row in (ticket.get("support_items") or []):
        if not item_row.is_submitted:
            item_row.is_submitted = 1

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


def _build_description(ticket_name, row):
    parts = [f"Ticket {ticket_name}"]
    if row.ruecksprache_erforderlich:
        parts.append("⚠️ Rücksprache")
    mult = int(row.multiplier or 1)
    if mult > 1:
        parts.append(f"{mult} Agenten")
    if row.description:
        parts.append(row.description)
    return " | ".join(parts)


def _create_timesheet(ticket, rows, customer_name):
    ts = frappe.new_doc("Timesheet")
    ts.customer = customer_name
    ts.note = f"HD Ticket: {ticket.name} — {ticket.subject or ''}"

    rabatt = cint(
        frappe.db.get_value("Customer", customer_name, "dienstleistungsrabatt") or 0
    ) if customer_name else 0

    for row in rows:
        price_per_hour = 0.0
        time_code = ""
        if row.price_category:
            pc = frappe.db.get_value(
                "Support Price Category",
                row.price_category,
                ["price_per_hour", "time_code", "activity_type", "category_name"],
                as_dict=True,
            )
            if pc:
                price_per_hour = pc.price_per_hour or 0
                time_code = pc.activity_type or pc.category_name or "Support"

        effective = float(row.effective_duration or 0)
        multiplier = int(row.multiplier or 1)
        billed_hours = effective * multiplier
        billing_amount = flt(billed_hours * price_per_hour * (1 - rabatt / 100), 2)

        ts.append("time_logs", {
            "activity_type": time_code or "Support",
            "from_time": row.start_time,
            "to_time": row.end_time,
            "hours": billed_hours,
            "billing_hours": billed_hours,
            "billing_rate": price_per_hour,
            "billing_amount": billing_amount,
            "custom_rabatt": rabatt,
            "custom_hd_agent": row.staff_member or "",
            "is_billable": 1,
            "project": row.get("project") or ticket.get("project") or "",
            "description": _build_description(ticket.name, row),
        })

    for item_row in (ticket.get("support_items") or []):
        if not item_row.is_submitted:
            ts.append("support_items", {
                "item_code": item_row.item_code,
                "item_name": item_row.item_name or "",
                "qty": item_row.qty or 1,
                "uom": item_row.uom or "",
                "project": ticket.get("project") or "",
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
        order_by="buchen_timestamp desc",
    )

    # Deduplicate by timesheet
    seen = {}
    for r in rows:
        if r.timesheet_ref not in seen:
            seen[r.timesheet_ref] = r.buchen_timestamp

    result = []
    for ts_name, ts_time in seen.items():
        total_hours = frappe.db.get_value(
            "Timesheet", ts_name, "total_billable_hours"
        ) or 0
        result.append({
            "timesheet": ts_name,
            "buchen_timestamp": ts_time,
            "total_hours": total_hours,
        })

    return result
