"""
Customer Support Overview Report.

Shows all Helpdesk tickets for a selected customer, with status, date,
total support hours (from Support Time Log), and associated contact.

Accessible by: Agent, Agent Manager, System Manager.
"""

import frappe
from frappe import _


def execute(filters=None):
    filters = filters or {}
    columns = get_columns()
    data = get_data(filters)
    return columns, data


def get_columns():
    return [
        {
            "label": _("Ticket"),
            "fieldname": "name",
            "fieldtype": "Link",
            "options": "HD Ticket",
            "width": 120,
        },
        {
            "label": _("Subject"),
            "fieldname": "subject",
            "fieldtype": "Data",
            "width": 260,
        },
        {
            "label": _("Status"),
            "fieldname": "status",
            "fieldtype": "Data",
            "width": 120,
        },
        {
            "label": _("Customer"),
            "fieldname": "customer",
            "fieldtype": "Link",
            "options": "HD Customer",
            "width": 160,
        },
        {
            "label": _("Contact"),
            "fieldname": "contact",
            "fieldtype": "Link",
            "options": "Contact",
            "width": 160,
        },
        {
            "label": _("Raised By"),
            "fieldname": "raised_by",
            "fieldtype": "Data",
            "width": 180,
        },
        {
            "label": _("Opening Date"),
            "fieldname": "opening_date",
            "fieldtype": "Date",
            "width": 110,
        },
        {
            "label": _("Resolution Date"),
            "fieldname": "resolution_date",
            "fieldtype": "Date",
            "width": 120,
        },
        {
            "label": _("Total Hours"),
            "fieldname": "total_hours",
            "fieldtype": "Float",
            "precision": 2,
            "width": 110,
        },
        {
            "label": _("Invoiced Hours"),
            "fieldname": "invoiced_hours",
            "fieldtype": "Float",
            "precision": 2,
            "width": 120,
        },
        {
            "label": _("Priority"),
            "fieldname": "priority",
            "fieldtype": "Data",
            "width": 90,
        },
    ]


def get_data(filters):
    conditions = []
    values = {}

    if filters.get("customer"):
        conditions.append("`tabHD Ticket`.customer = %(customer)s")
        values["customer"] = filters["customer"]

    if filters.get("status"):
        conditions.append("`tabHD Ticket`.status = %(status)s")
        values["status"] = filters["status"]

    if filters.get("from_date"):
        conditions.append("`tabHD Ticket`.opening_date >= %(from_date)s")
        values["from_date"] = filters["from_date"]

    if filters.get("to_date"):
        conditions.append("`tabHD Ticket`.opening_date <= %(to_date)s")
        values["to_date"] = filters["to_date"]

    where = "WHERE " + " AND ".join(conditions) if conditions else ""

    tickets = frappe.db.sql(
        f"""
        SELECT
            `tabHD Ticket`.name,
            `tabHD Ticket`.subject,
            `tabHD Ticket`.status,
            `tabHD Ticket`.customer,
            `tabHD Ticket`.contact,
            `tabHD Ticket`.raised_by,
            `tabHD Ticket`.opening_date,
            `tabHD Ticket`.resolution_date,
            `tabHD Ticket`.priority
        FROM `tabHD Ticket`
        {where}
        ORDER BY `tabHD Ticket`.opening_date DESC
        """,
        values,
        as_dict=True,
    )

    if not tickets:
        return []

    # Fetch time log hours if Support Time Log table exists
    ticket_hours = {}
    if frappe.db.table_exists("tabSupport Time Log"):
        ticket_names = [t.name for t in tickets]
        time_logs = frappe.db.sql(
            """
            SELECT
                parent,
                SUM(COALESCE(manual_override, duration, 0) * COALESCE(multiplier, 1)) AS total_hours,
                SUM(
                    CASE WHEN is_invoiced = 1
                    THEN COALESCE(manual_override, duration, 0) * COALESCE(multiplier, 1)
                    ELSE 0 END
                ) AS invoiced_hours
            FROM `tabSupport Time Log`
            WHERE parent IN %(ticket_names)s
            GROUP BY parent
            """,
            {"ticket_names": ticket_names},
            as_dict=True,
        )
        ticket_hours = {row.parent: row for row in time_logs}

    for ticket in tickets:
        hours = ticket_hours.get(ticket.name, {})
        ticket["total_hours"] = hours.get("total_hours") or 0
        ticket["invoiced_hours"] = hours.get("invoiced_hours") or 0

    return tickets


def get_filters():
    return [
        {
            "fieldname": "customer",
            "label": _("Customer"),
            "fieldtype": "Link",
            "options": "HD Customer",
        },
        {
            "fieldname": "status",
            "label": _("Status"),
            "fieldtype": "Select",
            "options": "\nOpen\nReplied\nResolved\nClosed",
        },
        {
            "fieldname": "from_date",
            "label": _("From Date"),
            "fieldtype": "Date",
        },
        {
            "fieldname": "to_date",
            "label": _("To Date"),
            "fieldtype": "Date",
        },
    ]
