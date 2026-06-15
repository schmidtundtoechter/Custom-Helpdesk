// Copyright (c) 2026, ahmad900mohammad@gmail.com and contributors
// For license information, please see license.txt

frappe.query_reports["HD Agent Support Report"] = {
	"filters": [
		{
			"fieldname": "from_date",
			"label": __("Von Datum"),
			"fieldtype": "Date",
			"reqd": 1,
			"default": frappe.datetime.month_start(),
		},
		{
			"fieldname": "to_date",
			"label": __("Bis Datum"),
			"fieldtype": "Date",
			"reqd": 1,
			"default": frappe.datetime.month_end(),
		},
		{
			"fieldname": "agent",
			"label": __("HD Agent"),
			"fieldtype": "Link",
			"options": "HD Agent",
		},
	]
};
