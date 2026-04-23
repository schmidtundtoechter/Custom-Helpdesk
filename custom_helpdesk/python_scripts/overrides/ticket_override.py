"""
HD Ticket overrides for Custom Helpdesk.

Handles:
- Status transition validation (customer cannot reopen Geschlossen tickets)
- Auto-close "Vorübergehend geschlossen" tickets after 21 days (scheduler)
- Recompute total_support_time and unbezahlte_supportzeit on ticket save
"""

import frappe
from frappe import _
from frappe.utils import add_days, now_datetime, today


CLOSED_STATUS = "Geschlossen"
TEMP_CLOSED_STATUS = "Vorübergehend geschlossen"
AUTO_CLOSE_DAYS = 21


def before_save(doc, method=None):
    _validate_status_transition(doc)
    _recompute_time_totals(doc)


def _validate_status_transition(doc):
    """
    Customers cannot reopen a 'Geschlossen' ticket.
    Agents and admins can change status freely.
    """
    try:
        from helpdesk.utils import is_agent
        if is_agent():
            return
    except ImportError:
        return

    if doc.is_new():
        return

    old_status = frappe.db.get_value("HD Ticket", doc.name, "status")
    if old_status == CLOSED_STATUS and doc.status != CLOSED_STATUS:
        frappe.throw(
            _("Geschlossene Tickets können nicht wieder geöffnet werden. "
              "Bitte erstellen Sie ein neues Ticket."),
            frappe.PermissionError,
        )


def _recompute_time_totals(doc):
    """
    Recalculate total_support_time and unbezahlte_supportzeit
    from the Support Time Log child table rows.
    """
    total = 0.0
    unbilled = 0.0
    for row in doc.get("support_time_logs") or []:
        effective = float(row.get("effective_duration") or 0)
        multiplier = int(row.get("multiplier") or 1)
        hours = effective * multiplier
        if not row.get("is_locked"):
            total += hours
        if not row.get("is_invoiced"):
            unbilled += hours
    doc.total_support_time = round(total, 2)
    doc.unbezahlte_supportzeit = round(unbilled, 2)


def auto_close_temp_closed_tickets():
    """
    Scheduler (daily): close all 'Vorübergehend geschlossen' tickets
    that have not been updated in the last 21 days.
    Called via hooks scheduler_events.
    """
    cutoff = add_days(today(), -AUTO_CLOSE_DAYS)
    tickets = frappe.get_all(
        "HD Ticket",
        filters={"status": TEMP_CLOSED_STATUS, "modified": ["<", cutoff]},
        fields=["name"],
    )
    for t in tickets:
        try:
            doc = frappe.get_doc("HD Ticket", t.name)
            doc.status = CLOSED_STATUS
            doc.flags.ignore_permissions = True
            doc.save()
            frappe.db.commit()
        except Exception:
            frappe.log_error(
                frappe.get_traceback(),
                f"Auto-close failed for HD Ticket {t.name}",
            )
