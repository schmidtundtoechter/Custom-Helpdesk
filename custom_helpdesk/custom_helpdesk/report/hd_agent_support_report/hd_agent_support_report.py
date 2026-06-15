# Copyright (c) 2026, ahmad900mohammad@gmail.com and contributors
# For license information, please see license.txt

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
			"label": _("HD Agent"),
			"fieldname": "agent",
			"fieldtype": "Link",
			"options": "HD Agent",
			"width": 140,
		},
		{
			"label": _("Agentname"),
			"fieldname": "agent_name",
			"fieldtype": "Data",
			"width": 180,
		},
		{
			"label": _("Monat"),
			"fieldname": "monat",
			"fieldtype": "Data",
			"width": 90,
		},
		{
			"label": _("Preiskategorie"),
			"fieldname": "preiskategorie",
			"fieldtype": "Data",
			"width": 200,
		},
		{
			"label": _("Stunden"),
			"fieldname": "stunden",
			"fieldtype": "Float",
			"precision": 2,
			"width": 100,
		},
		{
			"label": _("Betrag (€)"),
			"fieldname": "betrag",
			"fieldtype": "Currency",
			"width": 130,
		},
	]


def get_data(filters):
	from_date = filters.get("from_date")
	to_date = filters.get("to_date")
	agent = filters.get("agent")

	if not from_date or not to_date:
		return []

	agent_filter = ""
	values = {"from_date": from_date, "to_date": to_date}

	if agent:
		agent_filter = "AND td.custom_hd_agent = %(agent)s"
		values["agent"] = agent

	return frappe.db.sql(
		f"""
		SELECT
			td.custom_hd_agent AS agent,
			ha.agent_name,
			DATE_FORMAT(td.from_time, '%%Y-%%m') AS monat,
			td.activity_type AS preiskategorie,
			SUM(td.billing_hours) AS stunden,
			SUM(td.billing_amount) AS betrag
		FROM `tabTimesheet Detail` td
		LEFT JOIN `tabHD Agent` ha ON ha.name = td.custom_hd_agent
		WHERE td.custom_hd_agent IS NOT NULL
			AND td.custom_hd_agent != ''
			AND td.from_time BETWEEN %(from_date)s AND %(to_date)s
			{agent_filter}
		GROUP BY td.custom_hd_agent, DATE_FORMAT(td.from_time, '%%Y-%%m'), td.activity_type
		ORDER BY monat DESC, agent, preiskategorie
		""",
		values,
		as_dict=True,
	)


def get_filters():
	return [
		{
			"fieldname": "from_date",
			"label": _("Von Datum"),
			"fieldtype": "Date",
			"reqd": 1,
			"default": frappe.utils.get_first_day(frappe.utils.nowdate()),
		},
		{
			"fieldname": "to_date",
			"label": _("Bis Datum"),
			"fieldtype": "Date",
			"reqd": 1,
			"default": frappe.utils.get_last_day(frappe.utils.nowdate()),
		},
		{
			"fieldname": "agent",
			"label": _("HD Agent"),
			"fieldtype": "Link",
			"options": "HD Agent",
		},
	]
