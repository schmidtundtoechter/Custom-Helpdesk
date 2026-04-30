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
    _add_multiplier_comments(doc)


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
        if not row.get("gesperrt"):
            total += hours
        if not row.get("is_invoiced"):
            unbilled += hours
    doc.total_support_time = round(total, 2)
    doc.unbezahlte_supportzeit = round(unbilled, 2)


def _add_multiplier_comments(doc):
    """
    When a time log row has multiplier > 1 and the multiplier changed (or the row is new),
    post a visible comment to the ticket activity feed.
    """
    if doc.is_new():
        return

    existing_db = {
        r["name"]: r
        for r in frappe.get_all(
            "Support Time Log",
            filters={"parent": doc.name},
            fields=["name", "multiplier"],
        )
    }

    for row in doc.get("support_time_logs") or []:
        mult = int(row.get("multiplier") or 1)
        if mult <= 1:
            continue

        db_row = existing_db.get(row.name)
        db_mult = int(db_row.get("multiplier") or 1) if db_row else None
        is_new_row = db_row is None
        mult_changed = is_new_row or db_mult != mult

        if not mult_changed:
            continue

        eff = round(float(row.get("effective_duration") or row.get("duration") or 0), 2)
        total = round(eff * mult, 2)

        pc_label = row.price_category or "–"
        if row.price_category:
            cat_name = frappe.db.get_value("Support Price Category", row.price_category, "category_name")
            if cat_name:
                pc_label = f"{row.price_category} – {cat_name}"

        comment = f"Zeiterfassung: {eff:.2f}h × {mult} = {total:.2f}h (Kategorie: {pc_label})"
        doc.add_comment("Comment", text=comment)


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
