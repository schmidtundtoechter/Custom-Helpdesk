"""
Support Invoice API for Custom Helpdesk.

Provides server-side methods for the "Support abrechnen" (Bill Support)
workflow on ERPNext Sales Invoices.
"""

import json
import frappe
from frappe import _
from frappe.utils import getdate, flt, cint


@frappe.whitelist()
def get_support_invoice_candidates(customer, from_date, to_date, project=None, take_service_quota=0):
    """
    Return uninvoiced Timesheet rows matching the given customer and date range.
    Used by the "Suchen" step in the "Support abrechnen" dialog.
    """
    ts_filters = [
        ["customer", "=", customer],
        ["docstatus", "=", 1],
        ["custom_support_invoiced", "=", 0],
    ]

    timesheets = frappe.get_all(
        "Timesheet",
        filters=ts_filters,
        fields=["name"],
        order_by="start_date asc",
    )

    if not timesheets:
        return {"rows": []}

    ts_names = [ts.name for ts in timesheets]

    detail_filters = {"parent": ["in", ts_names], "is_billable": 1}
    if project:
        detail_filters["project"] = project
    else:
        detail_filters["project"] = ["in", ["", None]]

    details = frappe.get_all(
        "Timesheet Detail",
        filters=detail_filters,
        fields=[
            "name", "parent", "from_time", "to_time",
            "billing_hours", "hours", "billing_rate", "billing_amount",
            "activity_type", "project", "custom_rabatt", "description",
        ],
        order_by="from_time asc",
    )

    from_dt = getdate(from_date)
    to_dt = getdate(to_date)

    # Cache: (activity_type, billing_rate) → Support Price Category.category_name
    act_type_cache = {}

    rows = []
    for d in details:
        detail_date = d.from_time.date() if d.from_time else None
        if detail_date and (detail_date < from_dt or detail_date > to_dt):
            continue

        act_type = d.activity_type or ""
        billing_rate = flt(d.billing_rate, 2)
        cache_key = (act_type, billing_rate)

        if cache_key not in act_type_cache:
            pc_name = None
            # 1. Try by activity_type (properly configured price categories)
            if act_type:
                pc_name = frappe.db.get_value(
                    "Support Price Category",
                    {"activity_type": act_type, "is_active": 1},
                    "category_name",
                )
            # 2. Try by category_name (buchen now stores category_name as activity_type
            #    when activity_type is blank on the price category)
            if not pc_name and act_type:
                pc_name = frappe.db.get_value(
                    "Support Price Category",
                    {"category_name": act_type, "is_active": 1},
                    "category_name",
                )
            # 3. Fallback by billing_rate (handles old timesheets created before this fix)
            if not pc_name and billing_rate:
                pc_name = frappe.db.get_value(
                    "Support Price Category",
                    {"price_per_hour": billing_rate, "is_active": 1},
                    "category_name",
                )
            act_type_cache[cache_key] = pc_name or act_type or "Support"

        rows.append({
            "timesheet": d.parent,
            "timesheet_detail": d.name,
            "date": str(detail_date or ""),
            "from_time": str(d.from_time or ""),
            "to_time": str(d.to_time or ""),
            "project": d.project or "",
            "category_name": act_type_cache[cache_key],
            "hours": flt(d.billing_hours or d.hours, 4),
            "rate": flt(d.billing_rate, 2),
            "amount": flt(d.billing_amount, 2),  # already includes discount
            "rabatt": cint(d.custom_rabatt or 0),
            "description": d.description or "",
        })

    customer_rabatt = cint(
        frappe.db.get_value("Customer", customer, "dienstleistungsrabatt") or 0
    )
    return {"rows": rows, "customer_rabatt": customer_rabatt}


@frappe.whitelist()
def import_support_invoice_candidates(
    customer, from_date, to_date, project=None, take_service_quota=0, selected_rows=None
):
    """
    Aggregate selected Timesheet rows into Sales Invoice line items.
    Groups by price category, applies Dienstleistungskontingent if requested.
    Returns items list and the Timesheet names for invoiced-state tracking on submit.
    """
    if isinstance(selected_rows, str):
        selected_rows = json.loads(selected_rows)
    if not selected_rows:
        frappe.throw(_("Keine Zeilen ausgewählt."))

    take_service_quota = cint(take_service_quota)

    # Aggregate amount per category_name
    category_totals = {}
    timesheet_names = set()

    for row in selected_rows:
        cat = (row.get("category_name") or "").strip()
        # billing_amount already has the discount baked in from the Timesheet validate hook
        discounted = flt(row.get("amount", 0), 2)
        if cat not in category_totals:
            category_totals[cat] = 0.0
        category_totals[cat] += discounted
        if row.get("timesheet"):
            timesheet_names.add(row["timesheet"])

    items = []
    total_support_amount = 0.0

    for cat_name, total_amount in category_totals.items():
        # Items are manually pre-created with item_name = price category name
        item_code = frappe.db.get_value("Item", {"item_name": cat_name}, "name") or cat_name
        items.append({
            "item_code": item_code,
            "item_name": cat_name,
            "description": cat_name,
            "qty": 1,
            "rate": flt(total_amount, 2),
            "amount": flt(total_amount, 2),
        })
        total_support_amount += total_amount

    # Dienstleistungskontingent: only for non-project billing and when checkbox is on
    if take_service_quota and not project and total_support_amount > 0:
        quota = flt(
            frappe.db.get_value("Customer", customer, "dienstleistungskontingent") or 0
        )
        if quota > 0:
            # Cap: negative amount cannot exceed total support costs
            applied = min(quota, total_support_amount)
            quota_item_code = (
                frappe.db.get_value("Item", {"item_name": "Supportkontingent"}, "name")
                or "Supportkontingent"
            )
            items.append({
                "item_code": quota_item_code,
                "item_name": "Supportkontingent",
                "description": "Monatliches Dienstleistungskontingent",
                "qty": 1,
                "rate": -flt(applied, 2),
                "amount": -flt(applied, 2),
            })

    article_items = []
    for ts_name in timesheet_names:
        item_filters = {"parent": ts_name, "already_imported": 0}
        if project:
            item_filters["project"] = project
        else:
            item_filters["project"] = ["in", ["", None]]
        ts_items = frappe.get_all(
            "Timesheet Support Item",
            filters=item_filters,
            fields=["item_code", "item_name", "qty", "uom", "project"],
        )
        article_items.extend(ts_items)

    return {
        "customer": customer,
        "project": project or "",
        "items": items,
        "article_items": article_items,
        "timesheet_names": list(timesheet_names),
    }


def on_sales_invoice_submit(doc, method=None):
    """Mark imported Timesheets and their Support Time Logs as invoiced."""
    _update_invoiced_state(doc, invoiced=True)


def on_sales_invoice_cancel(doc, method=None):
    """Reverse invoiced state when a Sales Invoice is cancelled."""
    _update_invoiced_state(doc, invoiced=False)


def _update_invoiced_state(doc, invoiced):
    refs_json = doc.get("custom_support_timesheet_refs")
    if not refs_json:
        return
    try:
        timesheet_names = json.loads(refs_json)
    except Exception:
        return
    if not timesheet_names:
        return

    flag = 1 if invoiced else 0
    for ts_name in timesheet_names:
        frappe.db.set_value(
            "Timesheet", ts_name,
            "custom_support_invoiced", flag,
            update_modified=False,
        )
        stl_rows = frappe.get_all(
            "Support Time Log",
            filters={"timesheet_ref": ts_name},
            pluck="name",
        )
        for row_name in stl_rows:
            frappe.db.set_value(
                "Support Time Log", row_name,
                "is_invoiced", flag,
                update_modified=False,
            )
        tsi_rows = frappe.get_all(
            "Timesheet Support Item",
            filters={"parent": ts_name},
            pluck="name",
        )
        for row_name in tsi_rows:
            frappe.db.set_value(
                "Timesheet Support Item", row_name,
                "already_imported", flag,
                update_modified=False,
            )
