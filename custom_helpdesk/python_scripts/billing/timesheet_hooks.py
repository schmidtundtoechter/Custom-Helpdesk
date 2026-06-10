"""
Timesheet validate hook for Custom Helpdesk.

Recalculates billing_amount on each time_log row after ERPNext's own
validate() has run (which sets billing_amount = billing_hours * billing_rate).
Applies the custom_rabatt discount so the discounted amount is what gets stored
and later imported into the Sales Invoice.
"""

from frappe.utils import flt, cint


def on_timesheet_validate(doc, method=None):
    for row in (doc.time_logs or []):
        rabatt = cint(row.get("custom_rabatt") or 0)
        if rabatt <= 0:
            continue
        base = flt(row.billing_hours or 0) * flt(row.billing_rate or 0)
        discounted = flt(base * (1 - rabatt / 100), 2)
        row.billing_amount = discounted
        row.base_billing_amount = discounted
