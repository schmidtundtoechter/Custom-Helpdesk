"""
Incoming email handler for Custom Helpdesk.

When a customer replies to a ticket by email:
- "Vorübergehend geschlossen" → reopen ticket to "Offen"
- "Geschlossen" → block the reply, send auto-reply email

This hooks into Communication before_insert.
"""

import frappe
from frappe import _


CLOSED_STATUS = "Geschlossen"
TEMP_CLOSED_STATUS = "Vorübergehend geschlossen"
REOPEN_STATUS = "Offen"

AUTO_REPLY_TEMPLATE_DE = "Helpdesk Closed Ticket Auto-Reply DE"
AUTO_REPLY_TEMPLATE_EN = "Helpdesk Closed Ticket Auto-Reply EN"


def before_communication_insert(doc, method=None):
    """
    Called before_insert on Communication.
    Handles incoming customer emails linked to HD Tickets.
    """
    if frappe.flags.in_patch or frappe.flags.in_install or frappe.flags.in_migrate:
        return

    # Only handle incoming emails linked to HD Ticket
    if doc.communication_type != "Communication":
        return
    if doc.sent_or_received != "Received":
        return
    if doc.reference_doctype != "HD Ticket":
        return
    if not doc.reference_name:
        return

    ticket_status = frappe.db.get_value("HD Ticket", doc.reference_name, "status")
    if not ticket_status:
        return

    if ticket_status == TEMP_CLOSED_STATUS:
        _reopen_ticket(doc.reference_name)

    elif ticket_status == CLOSED_STATUS:
        _send_auto_reply(doc)
        # Mark the communication so Helpdesk does not process it as a new reply
        doc.seen = 1


def _reopen_ticket(ticket_name):
    """Reopen a Vorübergehend geschlossen ticket to Offen."""
    try:
        doc = frappe.get_doc("HD Ticket", ticket_name)
        doc.status = REOPEN_STATUS
        doc.flags.ignore_permissions = True
        doc.save()
        frappe.db.commit()
    except Exception:
        frappe.log_error(
            frappe.get_traceback(),
            f"Failed to reopen HD Ticket {ticket_name}",
        )


def _send_auto_reply(comm_doc):
    """Send the auto-reply email for a closed ticket."""
    sender_email = comm_doc.sender or comm_doc.sender_full_name
    if not sender_email:
        return

    # Determine language — default to German
    template_name = AUTO_REPLY_TEMPLATE_DE
    try:
        user_lang = frappe.db.get_value("User", sender_email, "language")
        if user_lang and user_lang.startswith("en"):
            template_name = AUTO_REPLY_TEMPLATE_EN
    except Exception:
        pass

    try:
        template = frappe.get_doc("Email Template", template_name)
        frappe.sendmail(
            recipients=[sender_email],
            subject=template.subject,
            message=template.response,
            now=True,
        )
    except Exception:
        frappe.log_error(
            frappe.get_traceback(),
            f"Failed to send auto-reply for closed ticket {comm_doc.reference_name}",
        )
