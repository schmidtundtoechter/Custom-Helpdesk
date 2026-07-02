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


def _employee_for_user(user):
    """Return the Employee name linked to a Frappe user, or None."""
    return frappe.db.get_value("Employee", {"user_id": user}, "name")


def _agent_for_user(user):
    """Return the HD Agent name linked to a Frappe user, or None."""
    return frappe.db.get_value("HD Agent", {"user": user}, "name")


@frappe.whitelist()
def get_csrf():
    """Return (and ensure) the session CSRF token via a safe GET request."""
    from frappe.sessions import get_csrf_token
    return get_csrf_token()


@frappe.whitelist()
def get_agents():
    """
    Return active HD Agents.
    Used by the portal to populate the Mitarbeiter dropdown.
    """
    agents = frappe.get_all(
        "HD Agent",
        filters={"is_active": 1},
        fields=["name", "user", "agent_name"],
    )
    return [
        {
            "name": a.name,
            "agent_name": a.agent_name or a.user,
            "user": a.user,
        }
        for a in agents
    ]


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
        "staff_member": _agent_for_user(frappe.session.user),
        "project": ticket.get("project") or "",
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
            if not row.staff_member:
                row.staff_member = _agent_for_user(frappe.session.user)
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

    allowed = {
        "multiplier", "price_category", "manual_override", "staff_member",
        "ruecksprache_erforderlich", "description", "start_time", "end_time",
        "project", "task",
    }
    updates = {k: v for k, v in json.loads(data).items() if k in allowed}
    if not updates:
        return

    time_fields = {"start_time", "end_time"}

    ticket = frappe.get_doc("HD Ticket", ticket_name)
    for row in ticket.support_time_logs:
        if row.name == row_name:
            if (row.gesperrt or row.is_invoiced) and updates.keys() & time_fields:
                frappe.throw(_("Start- und Endzeit können bei gesperrten oder abgerechneten Einträgen nicht geändert werden."))
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


@frappe.whitelist()
def get_ticket_details(ticket_name):
    """Return project, support_category, and customer for a ticket."""
    frappe.has_permission("HD Ticket", "read", ticket_name, throw=True)
    return frappe.db.get_value(
        "HD Ticket", ticket_name,
        ["project", "support_category", "customer"],
        as_dict=True,
    )


@frappe.whitelist()
def update_ticket_details(ticket_name, data):
    """Update project and/or support_category on an HD Ticket."""
    frappe.has_permission("HD Ticket", "write", ticket_name, throw=True)
    updates = {k: v for k, v in json.loads(data).items() if k in {"project", "support_category"}}
    if not updates:
        return
    frappe.db.set_value("HD Ticket", ticket_name, updates)
    frappe.db.commit()


@frappe.whitelist()
def get_ticket_items(ticket_name):
    """Return all HD Ticket Support Item rows for a ticket."""
    frappe.has_permission("HD Ticket", "read", ticket_name, throw=True)
    ticket = frappe.get_doc("HD Ticket", ticket_name)
    return [row.as_dict() for row in (ticket.support_items or [])]


@frappe.whitelist()
def add_ticket_item(ticket_name, data):
    """Append a new item row to the ticket's support_items table."""
    frappe.has_permission("HD Ticket", "write", ticket_name, throw=True)
    d = json.loads(data) if isinstance(data, str) else data
    if not d.get("item_code"):
        frappe.throw(_("Artikel ist erforderlich."))
    d.setdefault("item_name", frappe.db.get_value("Item", d["item_code"], "item_name") or d["item_code"])
    d.setdefault("uom", frappe.db.get_value("Item", d["item_code"], "stock_uom") or "")
    d.setdefault("qty", 1)
    ticket = frappe.get_doc("HD Ticket", ticket_name)
    row = ticket.append("support_items", {k: d[k] for k in ("item_code", "item_name", "qty", "uom") if k in d})
    ticket.flags.ignore_permissions = True
    ticket.save()
    return row.as_dict()


@frappe.whitelist()
def update_ticket_item(ticket_name, row_name, data):
    """Update qty and/or uom on a non-submitted Support Item row."""
    frappe.has_permission("HD Ticket", "write", ticket_name, throw=True)
    updates = {k: v for k, v in (json.loads(data) if isinstance(data, str) else data).items() if k in {"qty", "uom"}}
    if not updates:
        return
    ticket = frappe.get_doc("HD Ticket", ticket_name)
    for row in ticket.support_items:
        if row.name == row_name:
            if row.is_submitted:
                frappe.throw(_("Übertragene Artikel können nicht bearbeitet werden."))
            for f, v in updates.items():
                setattr(row, f, v)
            break
    else:
        frappe.throw(_("Artikel nicht gefunden: {0}").format(row_name))
    ticket.flags.ignore_permissions = True
    ticket.save()


@frappe.whitelist()
def delete_ticket_item(ticket_name, row_name):
    """Remove a non-submitted Support Item row from the ticket."""
    frappe.has_permission("HD Ticket", "write", ticket_name, throw=True)
    ticket = frappe.get_doc("HD Ticket", ticket_name)
    for i, row in enumerate(ticket.support_items or []):
        if row.name == row_name:
            if row.is_submitted:
                frappe.throw(_("Übertragene Artikel können nicht gelöscht werden."))
            ticket.support_items.pop(i)
            break
    else:
        frappe.throw(_("Artikel nicht gefunden: {0}").format(row_name))
    ticket.flags.ignore_permissions = True
    ticket.save()


@frappe.whitelist()
def get_projects(ticket_name=None):
    """Return active projects for the Projekt dropdown, filtered by ticket's customer."""
    filters = {"status": ["not in", ["Completed", "Cancelled"]]}
    if ticket_name:
        customer = frappe.db.get_value("HD Ticket", ticket_name, "customer")
        if customer:
            filters["customer"] = customer
    return frappe.get_all(
        "Project",
        filters=filters,
        fields=["name", "project_name"],
        order_by="project_name asc",
        limit=200,
    )


@frappe.whitelist()
def duplicate_time_log(ticket_name, row_name, copies):
    """
    Duplicate a Support Time Log row N times in the HD ticket.
    Each copy has the same times/price/description but empty staff_member and multiplier=1.
    The original row's multiplier is also reset to 1.
    Called when the agent selects multiplier > 1 in the Zeiterfassung panel.
    """
    frappe.has_permission("HD Ticket", "write", ticket_name, throw=True)
    copies = int(copies)
    if copies < 1 or copies > 11:
        frappe.throw(_("Ungültige Anzahl von Kopien."))

    ticket = frappe.get_doc("HD Ticket", ticket_name)
    original = None
    for row in ticket.support_time_logs:
        if row.name == row_name:
            original = row
            break
    else:
        frappe.throw(_("Zeiteintrag nicht gefunden: {0}").format(row_name))

    if original.gesperrt or original.is_invoiced:
        frappe.throw(_("Gesperrte oder abgerechnete Einträge können nicht dupliziert werden."))

    original.multiplier = "1"

    for _ in range(copies):
        ticket.append("support_time_logs", {
            "start_time": original.start_time,
            "end_time": original.end_time,
            "manual_override": original.manual_override,
            "description": original.description,
            "price_category": original.price_category,
            "project": original.project,
            "task": original.get("task") or "",
            "multiplier": "1",
            "staff_member": "",
            "entered_by": frappe.session.user,
            "ruecksprache_erforderlich": 0,
        })

    ticket.flags.ignore_permissions = True
    ticket.save()
    return {"copies_created": copies}


@frappe.whitelist()
def get_project_tasks(project):
    """Return open Tasks for a given project."""
    return frappe.get_all(
        "Task",
        filters={"project": project, "status": ["not in", ["Cancelled", "Template"]]},
        fields=["name", "subject"],
        order_by="subject asc",
        limit=200,
    )


@frappe.whitelist()
def get_closed_statuses():
    """Return label_agent list of HD Ticket Status records with category='Closed'."""
    return frappe.get_all(
        "HD Ticket Status",
        filters={"category": ["in", ["Closed", "Resolved"]], "enabled": 1},
        pluck="label_agent",
    )


@frappe.whitelist()
def save_closing_details(ticket_name, data):
    """Save closing dialog fields to an HD Ticket."""
    frappe.has_permission("HD Ticket", "write", ticket_name, throw=True)
    allowed = {
        "zeiteintraege_vollstaendig", "kunde_benachrichtigt", "fahrten_abgerechnet",
        "klassifizierung", "schliessungsstatus",
        "schliessungs_kommentar", "schliessungs_kommentar_intern",
    }
    updates = {k: v for k, v in (json.loads(data) if isinstance(data, str) else data).items() if k in allowed}
    if updates:
        frappe.db.set_value("HD Ticket", ticket_name, updates)
        frappe.db.commit()
